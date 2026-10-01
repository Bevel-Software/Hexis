---
'@bevel-software/platform-core-backend': minor
---

Personal data in the database is now AES-256-GCM ciphertext: emails, display names and avatar addresses, including the copies on approvals, merge log entries, review comments, change requests, queued commits, file locks and plugin join requests; change-request titles and bodies; review comment bodies; and the error text the merge log, the commit queue and a join request keep. The key is derived from `SECRETS_ENC_KEY`, so there is nothing new to set, and a database dump, an injected query or a leaked database credential yields no personal data. The first start after the upgrade seals the rows that are there; nothing to do. From this release, losing `SECRETS_ENC_KEY` loses this data too: keep a copy outside the server.

Equality on an encrypted column goes through a deterministic blind index beside it (`*_bidx`): sign-in, account upserts, approval idempotency, join-request uniqueness and account erasure all key on it, and the unique constraints moved there (`users_email_bidx_unq`, `pr_file_approvals_bidx_unq`, `plugin_join_requests_requester_bidx_plugin_unq`). Erasure rewrites the index to the placeholder's and refuses to run on a row the configured key cannot open.

A process that serves several knowledge bases seals every tenant's rows with one key derived from `TENANT_MASTER_KEY` (`deriveHostPiiKey`); a tenant's dump therefore opens with that key, not with its own secrets key, until it is re-sealed (docs/multi-tenant.md).

For overlays: `encryptedText`, `blindIndex`, `encryptPii`, `decryptPii`, `isEncryptedBlob`, `initColumnCrypto` and `isColumnCryptoInitialised` are exported so an overlay seals its own schema's columns with the same keys. `runCoreMigrations` now also seals the core rows under its lock; `createCoreServices` refuses to build a graph before `initColumnCrypto` ran (`CoreConfig`'s constructor and the tenant host both run it). Never `eq()` an encrypted column: the ciphertext is randomized, so compare the blind index.
