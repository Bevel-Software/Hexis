import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifySyncCredential, type SyncSessionVerifier } from '../sync-auth.js';

const SECRET = 'a-very-long-and-random-sync-secret';

function session(opts: { email?: string; admin?: boolean } = {}): SyncSessionVerifier {
  return {
    verifyJwt: vi.fn((token: string) =>
      token === 'jwt-ok' && opts.email ? { email: opts.email } : null,
    ),
    isAdmin: vi.fn(async () => opts.admin === true),
  };
}

describe('verifySyncCredential', () => {
  it('accepts the secret as a bearer', async () => {
    const r = await verifySyncCredential(
      { secret: SECRET, authorization: `Bearer ${SECRET}` },
      session(),
    );
    expect(r).toEqual({ ok: true, credential: { kind: 'bearer' } });
  });

  it('refuses a wrong bearer with 401', async () => {
    const r = await verifySyncCredential(
      { secret: SECRET, authorization: 'Bearer nope' },
      session(),
    );
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses a missing credential with 401', async () => {
    const r = await verifySyncCredential({ secret: SECRET }, session());
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('accepts the GitLab token header', async () => {
    const r = await verifySyncCredential({ secret: SECRET, gitlabToken: SECRET }, session());
    expect(r).toEqual({ ok: true, credential: { kind: 'gitlab-token' } });
  });

  it('accepts a GitHub signature over the raw body, and only over those bytes', async () => {
    const body = Buffer.from('{"ref":"refs/heads/main"}');
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
    expect(
      await verifySyncCredential({ secret: SECRET, hubSignature: sig, rawBody: body }, session()),
    ).toEqual({ ok: true, credential: { kind: 'github-signature' } });
    expect(
      await verifySyncCredential(
        { secret: SECRET, hubSignature: sig, rawBody: Buffer.from('{"ref":"refs/heads/other"}') },
        session(),
      ),
    ).toMatchObject({ ok: false, status: 401 });
    expect(
      await verifySyncCredential(
        { secret: SECRET, hubSignature: 'sha1=abc', rawBody: body },
        session(),
      ),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("accepts an admin's own session as the bearer", async () => {
    const r = await verifySyncCredential(
      { secret: SECRET, authorization: 'Bearer jwt-ok' },
      session({ email: 'admin@example.com', admin: true }),
    );
    expect(r).toEqual({
      ok: true,
      credential: { kind: 'admin-session', email: 'admin@example.com' },
    });
  });

  it("refuses a non-admin's session", async () => {
    const r = await verifySyncCredential(
      { secret: SECRET, authorization: 'Bearer jwt-ok' },
      session({ email: 'someone@example.com', admin: false }),
    );
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('with no secret configured, a header credential gets 503 that says so', async () => {
    const r = await verifySyncCredential({ secret: '', authorization: 'Bearer anything' }, session());
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect((r as { message: string }).message).toContain('KB_SYNC_SECRET');
  });

  it('with no secret configured, an admin session still works', async () => {
    const r = await verifySyncCredential(
      { secret: '', authorization: 'Bearer jwt-ok' },
      session({ email: 'admin@example.com', admin: true }),
    );
    expect(r).toMatchObject({ ok: true });
  });

  it('with no secret configured and no credential, 401 not 503', async () => {
    expect(await verifySyncCredential({ secret: '' }, session())).toMatchObject({
      ok: false,
      status: 401,
    });
  });
});
