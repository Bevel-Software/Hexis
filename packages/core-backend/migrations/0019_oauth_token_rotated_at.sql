-- When a refresh of the row's refresh token minted its successor. Rotation
-- sets it; a revoke never does, so the two are told apart: a rotated row's
-- access token still verifies until its own expiry, and its refresh token is
-- honoured once more within the reuse grace, while a revoked row does neither
-- (see `exchangeRefreshToken` in bevel-oauth-provider.ts). Null on every
-- existing row, which rotation then marks as it does any other.
ALTER TABLE "oauth_tokens" ADD COLUMN "rotated_at" timestamp;