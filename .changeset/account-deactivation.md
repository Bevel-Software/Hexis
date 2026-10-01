---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

An admin can switch an account off, and add someone without a password.

**Switching an account off.** The User accounts page has a Switch off button on every row except your own and the deployment admin's. A switched-off account keeps its row, its history and its place in roles and groups. What changes is that nothing it holds is honoured any more:
- It cannot sign in, by password or single sign-on.
- Its session is refused on the next request; until now a session lasted its full seven days.
- Its connection keys, agent (MCP OAuth) tokens and internal tokens stop working.

Switch on restores all of them as they were. Sessions and internal tokens are checked against the account at most every 30 seconds per process. Connection keys and agent tokens are checked on every use, because their lookup already reads the account.

The deployment admin (`ADMIN_EMAIL` while `ADMIN_PASSWORD` is set) cannot be switched off, because its environment password is the way back into a deployment. Neither can the platform's own bot accounts. An admin cannot switch off their own account, so an admin who can sign in always remains. A person whose account is off and who tries to sign in is told so: password sign-in says it only after the password is proven.

**Adding someone without a password.** `POST /api/admin/accounts` no longer requires `password`. Without one, the account is made for single sign-on and waits for the person's first sign-in. The Add account form says so.

**For hosts that sell seats.** A seat is now an account that is on.
- `AccountProvisionReason` gains `'reactivate'`: switching an account back on asks the admission port, as a new account does, and a refusal reaches the admin as a 403 with the port's words.
- A refusing verdict may carry `waitForAdmin: true`. On a first single sign-on sign-in, the person is then created switched off, so an admin finds them waiting on the accounts list, and the sign-in is refused with the port's words. Everywhere else it is a plain refusal.

New:
- column `users.deactivated_at` (migration `0015`);
- `AuthService.isActive`, `resolveSession`, `deactivate` and `reactivate`;
- routes `POST /api/admin/accounts/:userId/deactivate` and `/reactivate`;
- exported from the package root: `AccountDeactivatedError` and `ACCOUNT_DEACTIVATED_MESSAGE`.

Changed:
- `AccountAdmissionRefusedError` carries `waitingForAdmin`.
- `listAccounts` rows carry `deactivatedAt`.
- `createAuthMiddleware` is async and takes anything with `resolveSession`.
- `createTokenVerifier` and `createToolAuthMiddleware` take an optional third argument, the account checker for internal tokens.
- `SyncSessionVerifier.verifyJwt` may return a promise.
- The single sign-on callback adds the error codes `waiting` and `deactivated`.
