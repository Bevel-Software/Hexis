import { describe, expect, it } from 'vitest';
import { scopesCovered, missingScopes } from '../secrets-vault.contract.js';

/**
 * `scopesCovered(required, granted)` — the pure predicate the MCP pre-check and the
 * connect route share to decide whether a token still covers a tool's live scopes.
 */
describe('scopesCovered', () => {
  it('is trivially covered when nothing is required', () => {
    expect(scopesCovered(undefined, undefined)).toBe(true);
    expect(scopesCovered([], 'openid')).toBe(true);
  });

  it('covers when every required scope is granted (order/extra-granted irrelevant)', () => {
    expect(scopesCovered(['openid'], 'openid')).toBe(true);
    expect(scopesCovered(['a', 'b'], 'b a c')).toBe(true);
  });

  it('does not cover when a required scope is missing', () => {
    expect(scopesCovered(['openid', 'calendar'], 'openid')).toBe(false);
  });

  it('does not cover when the granted set is unknown but scopes are required', () => {
    expect(scopesCovered(['openid'], undefined)).toBe(false);
    expect(scopesCovered(['openid'], '')).toBe(false);
  });

  it('ignores extra whitespace between granted scopes', () => {
    expect(scopesCovered(['a', 'b'], '  a   b  ')).toBe(true);
  });

  // Google canonicalizes `email`/`profile` to userinfo.* URLs in the echoed grant.
  describe('Google OIDC alias canonicalization', () => {
    const EMAIL_URL = 'https://www.googleapis.com/auth/userinfo.email';
    const PROFILE_URL = 'https://www.googleapis.com/auth/userinfo.profile';
    const CAL = 'https://www.googleapis.com/auth/calendar.readonly';

    it('covers a bare `email` required against the URL Google granted (the reported bug)', () => {
      expect(scopesCovered(['email'], EMAIL_URL)).toBe(true);
    });

    it('covers symmetrically: URL required, bare alias granted', () => {
      expect(scopesCovered([EMAIL_URL], 'email')).toBe(true);
    });

    it('covers the `profile` pair the same way', () => {
      expect(scopesCovered(['profile'], PROFILE_URL)).toBe(true);
    });

    it('covers the full google.tool grant after re-consent (requirement #1)', () => {
      expect(scopesCovered(['openid', 'email', CAL], `openid ${EMAIL_URL} ${CAL}`)).toBe(true);
    });

    it('still gates a token missing calendar.readonly (requirement #2)', () => {
      expect(scopesCovered(['openid', 'email', CAL], `openid ${EMAIL_URL}`)).toBe(false);
    });

    it('preserves fail-closed on unknown/empty granted through canonicalization', () => {
      expect(scopesCovered(['email'], undefined)).toBe(false);
      expect(scopesCovered(['email'], '')).toBe(false);
    });

    it('does NOT treat a subsumption as coverage (no subsumption leaked into the table)', () => {
      expect(scopesCovered(['https://www.googleapis.com/auth/contacts'], 'https://www.google.com/m8/feeds/')).toBe(false);
    });

    it('keeps `openid` verbatim — never aliased to a URL', () => {
      expect(scopesCovered(['openid'], 'openid')).toBe(true);
      expect(scopesCovered(['openid'], EMAIL_URL)).toBe(false);
    });
  });
});

/**
 * `missingScopes(required, granted)` — the declared scopes a token doesn't cover,
 * in their ORIGINAL form, for showing "what it can't do" in the secrets UI.
 */
describe('missingScopes', () => {
  const EMAIL_URL = 'https://www.googleapis.com/auth/userinfo.email';
  const CAL = 'https://www.googleapis.com/auth/calendar.readonly';
  const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';

  it('returns [] when everything required is covered', () => {
    expect(missingScopes(['openid', 'email'], `openid ${EMAIL_URL}`)).toEqual([]);
    expect(missingScopes(undefined, 'anything')).toEqual([]);
    expect(missingScopes([], undefined)).toEqual([]);
  });

  it('lists the uncovered scopes in their declared form', () => {
    // A token granted calendar but not gmail (the reported scenario).
    expect(missingScopes(['openid', 'email', CAL, GMAIL], `openid ${EMAIL_URL} ${CAL}`)).toEqual([GMAIL]);
  });

  it('treats an alias as covered (email vs userinfo.email)', () => {
    expect(missingScopes(['email'], EMAIL_URL)).toEqual([]);
  });

  it('lists everything required when granted is unknown (fail-closed)', () => {
    expect(missingScopes(['openid', 'email'], undefined)).toEqual(['openid', 'email']);
  });
});

/**
 * `offline_access` asks for a refresh token and grants no access. Microsoft's identity
 * platform grants it but never echoes it in `scope`, so it must not count as missing.
 */
describe('request-only scopes (offline_access)', () => {
  // The `scope` Microsoft echoed for a Teams sign-in that asked for offline_access
  // and got a refresh_token (captured 2026-11-10; it lists every scope the app was
  // ever consented for, and never offline_access).
  const MICROSOFT_ECHO =
    'Channel.ReadBasic.All ChannelMember.Read.All ChannelMessage.Read.All Chat.Read ChatMember.Read ' +
    'email openid profile Team.ReadBasic.All User.Read';
  const TEAMS = [
    'offline_access',
    'User.Read',
    'Chat.Read',
    'ChatMember.Read',
    'ChannelMessage.Read.All',
    'ChannelMember.Read.All',
    'Team.ReadBasic.All',
    'Channel.ReadBasic.All',
  ];

  it('covers a Microsoft grant that omits offline_access (the reported bug)', () => {
    expect(scopesCovered(TEAMS, MICROSOFT_ECHO)).toBe(true);
    expect(missingScopes(TEAMS, MICROSOFT_ECHO)).toEqual([]);
  });

  it('still covers when a provider does echo offline_access', () => {
    expect(scopesCovered(['offline_access', 'User.Read'], 'offline_access User.Read')).toBe(true);
  });

  it('still gates a real permission missing next to offline_access', () => {
    expect(missingScopes(['offline_access', 'User.Read', 'Mail.Send'], 'User.Read')).toEqual(['Mail.Send']);
    expect(scopesCovered(['offline_access', 'Mail.Send'], 'User.Read')).toBe(false);
  });

  it('keeps fail-closed for the real scopes when granted is unknown', () => {
    expect(missingScopes(['offline_access', 'User.Read'], undefined)).toEqual(['User.Read']);
    expect(scopesCovered(['offline_access', 'User.Read'], '')).toBe(false);
  });

  it('exempts only the exact name, not look-alikes', () => {
    expect(missingScopes(['Offline_Access', 'offline'], 'User.Read')).toEqual(['Offline_Access', 'offline']);
  });
});
