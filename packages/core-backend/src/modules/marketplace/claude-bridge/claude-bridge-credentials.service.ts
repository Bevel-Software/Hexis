import { generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../database/connection.js';
import { claudeMarketplaceBridge } from '../../database/schema.js';
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
export interface ClaudeBridgeCredentials {
  appId: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKeyPem: string;
  publicKeyPem: string;
  createdAt: Date;
  rotatedAt: Date | null;
}

/** Where the one credentials row lives — the database in production, memory in tests. */
export interface ClaudeBridgeCredentialsStore {
  load(): Promise<ClaudeBridgeCredentials | null>;
  save(creds: ClaudeBridgeCredentials): Promise<void>;
}

const ROW_ID = 'default';

/**
 * The database-backed store. Secrets are sealed with the deployment's secrets
 * key, exactly as stored settings are; without that key there is nowhere safe
 * to keep a client secret, so the store refuses rather than writing plaintext.
 */
export class DbClaudeBridgeCredentialsStore implements ClaudeBridgeCredentialsStore {
  constructor(
    private readonly db: Database,
    private readonly crypto: TokenCrypto | null,
  ) {}

  async load(): Promise<ClaudeBridgeCredentials | null> {
    const [row] = await this.db
      .select()
      .from(claudeMarketplaceBridge)
      .where(eq(claudeMarketplaceBridge.id, ROW_ID))
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

  async save(creds: ClaudeBridgeCredentials): Promise<void> {
    const crypto = this.requireCrypto();
    const sealed = {
      appId: creds.appId,
      clientId: creds.clientId,
      clientSecret: crypto.encrypt(creds.clientSecret),
      webhookSecret: crypto.encrypt(creds.webhookSecret),
      privateKeyPem: crypto.encrypt(creds.privateKeyPem),
      publicKeyPem: creds.publicKeyPem,
      createdAt: creds.createdAt,
      rotatedAt: creds.rotatedAt,
    };
    await this.db
      .insert(claudeMarketplaceBridge)
      .values({ id: ROW_ID, ...sealed })
      .onConflictDoUpdate({ target: claudeMarketplaceBridge.id, set: sealed });
  }

  private requireCrypto(): TokenCrypto {
    if (!this.crypto) {
      throw new ClaudeBridgeUnavailableError(
        'SECRETS_ENC_KEY is not set, so the Claude connection credentials cannot be stored.',
      );
    }
    return this.crypto;
  }
}

export class ClaudeBridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeBridgeUnavailableError';
  }
}

/**
 * Generates the credentials once and hands them out afterwards. Cached after
 * the first load: the token exchange checks the client secret on every
 * connect, and the row never changes except through {@link rotate}.
 */
export class ClaudeBridgeCredentialsService {
  private cached: ClaudeBridgeCredentials | null = null;
  private inflight: Promise<ClaudeBridgeCredentials> | null = null;

  constructor(private readonly store: ClaudeBridgeCredentialsStore) {}

  /** The credentials, generated on first use. */
  async ensure(): Promise<ClaudeBridgeCredentials> {
    if (this.cached) return this.cached;
    this.inflight ??= (async () => {
      const existing = await this.store.load();
      if (existing) return (this.cached = existing);
      const fresh = generateCredentials(null);
      await this.store.save(fresh);
      return (this.cached = fresh);
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * New credentials, all of them. Every existing registration on the Claude
   * side stops matching at once — the client secret it holds is gone — which
   * is the point of rotating: the Owner re-enters the new set, and connected
   * users' tokens (connection keys) are untouched, since those are ours.
   */
  async rotate(): Promise<ClaudeBridgeCredentials> {
    const current = await this.ensure();
    const fresh = generateCredentials(current.createdAt);
    await this.store.save(fresh);
    this.cached = fresh;
    return fresh;
  }
}

function generateCredentials(createdAt: Date | null): ClaudeBridgeCredentials {
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

/** For tests and single-process hosts: the row kept in memory. */
export class MemoryClaudeBridgeCredentialsStore implements ClaudeBridgeCredentialsStore {
  private row: ClaudeBridgeCredentials | null = null;
  async load(): Promise<ClaudeBridgeCredentials | null> {
    return this.row;
  }
  async save(creds: ClaudeBridgeCredentials): Promise<void> {
    this.row = creds;
  }
}
