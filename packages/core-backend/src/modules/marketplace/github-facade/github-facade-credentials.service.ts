import { generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../database/connection.js';
import { githubFacadeIdentity } from '../../database/schema.js';
import type { TokenCrypto } from '../../../shared/token-crypto.js';

/**
 * What Claude's "Add manually" form for a GitHub Enterprise Server asks an
 * Owner to paste, and what the token exchange later checks: the identity
 * this deployment presents to claude.ai as if it were a GitHub App.
 *
 * Every field is generated HERE, once per deployment — nothing is registered
 * anywhere else, because there is no GitHub: hexis is the host Claude talks
 * to. The private key is handed over because the form requires one; the
 * user-added marketplace flow never signs with it (the observed contract is
 * the OAuth pair plus three REST calls), but a future organization
 * marketplace would, and rotating everything together is simpler than
 * explaining which half matters.
 */
export interface GitHubFacadeCredentials {
  appId: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKeyPem: string;
  publicKeyPem: string;
  createdAt: Date;
  rotatedAt: Date | null;
}

/**
 * Where the one credentials row lives — the database in production, memory
 * in tests. THE row, not a copy of it: every replica reads the store on
 * every use, so a rotation on one replica is what every other replica
 * checks the very next exchange. The reads are rare (a connect, an admin
 * page), and a cache would be a second source of truth with no invalidation.
 *
 * Both writes are conditional, so two replicas writing at once cannot
 * disagree about what is stored: creation happens only when no row exists,
 * and a rotation replaces only the set the caller was looking at. Either way
 * the caller gets back what the store holds afterwards, never what it sent.
 */
export interface GitHubFacadeCredentialsStore {
  load(): Promise<GitHubFacadeCredentials | null>;
  /**
   * Store `creds` only if no row exists yet, and return whichever row
   * exists afterwards — so two replicas initialising at once agree on one
   * set, and the loser's generated values are simply dropped.
   */
  createIfAbsent(creds: GitHubFacadeCredentials): Promise<GitHubFacadeCredentials>;
  /**
   * Replace the row only while it still carries `expectedClientId`, and
   * return what is stored afterwards. Two admins rotating at once: the first
   * write wins, the second finds a different client id, writes nothing, and
   * is shown the winner's set — the only one Claude will accept.
   */
  replaceIfCurrent(expectedClientId: string, creds: GitHubFacadeCredentials): Promise<GitHubFacadeCredentials>;
}

const ROW_ID = 'default';

/**
 * The database-backed store. Secrets are sealed with the deployment's secrets
 * key, exactly as stored settings are; without that key there is nowhere safe
 * to keep a client secret, so the store refuses rather than writing plaintext.
 */
export class DbGitHubFacadeCredentialsStore implements GitHubFacadeCredentialsStore {
  constructor(
    private readonly db: Database,
    private readonly crypto: TokenCrypto | null,
  ) {}

  async load(): Promise<GitHubFacadeCredentials | null> {
    const [row] = await this.db
      .select()
      .from(githubFacadeIdentity)
      .where(eq(githubFacadeIdentity.id, ROW_ID))
      .limit(1);
    if (!row) return null;
    const crypto = this.requireCrypto();
    return {
      appId: row.appId,
      clientId: row.clientId,
      clientSecret: crypto.decrypt(row.clientSecret),
      webhookSecret: crypto.decrypt(row.webhookSecret),
      privateKeyPem: crypto.decrypt(row.privateKeyPem),
      publicKeyPem: row.publicKeyPem,
      createdAt: row.createdAt,
      rotatedAt: row.rotatedAt,
    };
  }

  async createIfAbsent(creds: GitHubFacadeCredentials): Promise<GitHubFacadeCredentials> {
    await this.db
      .insert(githubFacadeIdentity)
      .values({ id: ROW_ID, ...this.seal(creds) })
      .onConflictDoNothing({ target: githubFacadeIdentity.id });
    return this.stored('insert');
  }

  async replaceIfCurrent(expectedClientId: string, creds: GitHubFacadeCredentials): Promise<GitHubFacadeCredentials> {
    await this.db
      .update(githubFacadeIdentity)
      .set(this.seal(creds))
      .where(and(eq(githubFacadeIdentity.id, ROW_ID), eq(githubFacadeIdentity.clientId, expectedClientId)));
    return this.stored('replace');
  }

  private async stored(after: string): Promise<GitHubFacadeCredentials> {
    const row = await this.load();
    if (!row) throw new Error(`claude bridge credentials vanished between ${after} and read`);
    return row;
  }

  private seal(creds: GitHubFacadeCredentials) {
    const crypto = this.requireCrypto();
    return {
      appId: creds.appId,
      clientId: creds.clientId,
      clientSecret: crypto.encrypt(creds.clientSecret),
      webhookSecret: crypto.encrypt(creds.webhookSecret),
      privateKeyPem: crypto.encrypt(creds.privateKeyPem),
      publicKeyPem: creds.publicKeyPem,
      createdAt: creds.createdAt,
      rotatedAt: creds.rotatedAt,
    };
  }

  private requireCrypto(): TokenCrypto {
    if (!this.crypto) {
      throw new GitHubFacadeUnavailableError(
        'SECRETS_ENC_KEY is not set, so the Claude connection credentials cannot be stored.',
      );
    }
    return this.crypto;
  }
}

export class GitHubFacadeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubFacadeUnavailableError';
  }
}

/**
 * Generates the credentials on first use and reads them from the store on
 * every use after that. No in-process copy: the store is the one place the
 * truth lives, whichever replica asks.
 */
export class GitHubFacadeCredentialsService {
  constructor(private readonly store: GitHubFacadeCredentialsStore) {}

  /** The credentials, generated on first use. */
  async ensure(): Promise<GitHubFacadeCredentials> {
    const existing = await this.store.load();
    if (existing) return existing;
    return this.store.createIfAbsent(generateCredentials(null));
  }

  /**
   * New credentials, all of them — replacing the set this call read, and
   * returning whatever is stored afterwards. Every registration on the
   * Claude side stops matching at once, which is the point of rotating: the
   * Owner re-enters the new set, and connected users' tokens (connection
   * keys) are untouched, since those are ours.
   */
  async rotate(): Promise<GitHubFacadeCredentials> {
    const current = await this.ensure();
    return this.store.replaceIfCurrent(current.clientId, generateCredentials(current.createdAt));
  }
}

function generateCredentials(createdAt: Date | null): GitHubFacadeCredentials {
  // The shapes GitHub uses, because the form was built for them: a numeric
  // app id, an `Iv1.`-prefixed client id, hex secrets, a PKCS#1 RSA key.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    appId: String(randomInt(100_000, 999_999)),
    clientId: `Iv1.${randomBytes(8).toString('hex')}`,
    clientSecret: randomBytes(20).toString('hex'),
    webhookSecret: randomBytes(16).toString('hex'),
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    createdAt: createdAt ?? new Date(),
    rotatedAt: createdAt ? new Date() : null,
  };
}

/** For tests: the row kept in memory, with the same conditional writes. */
export class MemoryGitHubFacadeCredentialsStore implements GitHubFacadeCredentialsStore {
  private row: GitHubFacadeCredentials | null = null;
  async load(): Promise<GitHubFacadeCredentials | null> {
    return this.row;
  }
  async createIfAbsent(creds: GitHubFacadeCredentials): Promise<GitHubFacadeCredentials> {
    this.row ??= creds;
    return this.row;
  }
  async replaceIfCurrent(expectedClientId: string, creds: GitHubFacadeCredentials): Promise<GitHubFacadeCredentials> {
    if (this.row?.clientId === expectedClientId) this.row = creds;
    return this.row!;
  }
}
