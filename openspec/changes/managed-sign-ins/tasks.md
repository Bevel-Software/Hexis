## 1. Tool manuals (packages/core-backend)

- [x] 1.1 `src/modules/tool-manuals/tool-manuals.contract.ts`: `ToolVariableOAuth.clientId?`, `managed?: ManagedSignIn`, `IToolManualService.sharedSignInKeysForManual`
- [x] 1.2 `src/modules/tool-manuals/tool-manuals.service.ts`: parse `managed` (ids only, never echoed), allow `oauth` on `admin` only when managed, guard the discovery path's client id, `sharedSignInKeysForManual`
- [x] 1.3 `src/modules/tool-manuals/__tests__/tool-manuals.managed-sign-in.test.ts`

## 2. Secrets vault (packages/core-backend)

- [x] 2.1 `src/modules/secrets-vault/secrets-vault.contract.ts`: `ManagedSignInRef`, `DeliveredTokenSet`, `ManagedTokenRefresher`, `ManagedTokenRevoker`, `ManagedSignInCard`, `ManagedSignInPort`, `OAuthProviderConfig.managed/account`, status fields, the three vault methods
- [x] 2.2 `src/modules/secrets-vault/db-secrets-vault.service.ts`: `pendingNonce`, `setManagedTokenHandlers`, `beginManagedConnection`, `completeManagedConnection`, `removeManagedRowsOfUser`, revoke-before-delete, the managed branch of `refreshRow`, `forceRefresh` on the shared row, `readMeta`/`requireProvider` without a client id when managed
- [x] 2.3 `src/modules/secrets-vault/secrets-vault.routes.ts`: `managedSignIns` dep, `managed` on `/secrets/tools` and `/connect/pending`, the start route's delegation, `clientId` on the client-secret route
- [x] 2.4 `src/modules/secrets-vault/__tests__/db-secrets-vault.managed.test.ts`

## 3. MCP, auth, composition (packages/core-backend)

- [x] 3.1 `src/modules/mcp/mcp.service.ts`: shared sign-ins in `missingUserSecrets`
- [x] 3.2 `src/modules/tool-manuals/tool-manuals.tools.ts`: `list_tool_setup` reads `adminAuthorized` for a shared sign-in and carries `managed`
- [x] 3.3 `src/modules/auth/account-hooks.ts`, `account.routes.ts`: `onAccountDeactivated`, fired after deactivate
- [x] 3.4 `src/core/core-ports.ts`, `create-core-services.ts`, `create-core-server.ts`: `managedSignIns`
- [x] 3.5 Test doubles that stub the two seams (`mcp.service.test.ts`, `mcp.e2e.test.ts`, `account.routes.test.ts`, `roles-admin.security.test.ts`)

## 4. Frontend (packages/core-frontend)

- [x] 4.1 `src/modules/secrets-vault/services/connect.api.ts`, `tool-secrets.api.ts`: `ManagedSignIn`, `clientId` on `setOAuthClientSecret`
- [x] 4.2 `src/modules/secrets-vault/components/ManagedConnectorCard.tsx` and its test; `ConnectToolsPage.tsx`: the Connectors section, disconnect, the registry panel
- [x] 4.3 `src/core/registry.ts`: `connectPanel`, `ConnectPanelProps`

## 5. Docs and release

- [x] 5.1 This change folder; `agent-guide/tool-manuals.md` row for `managed`; changeset for the fixed version group
