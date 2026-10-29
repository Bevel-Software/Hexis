/**
 * What the tool-auth module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move. Export what another module needs; nothing more.
 */
export { rejectConnectionKey } from './connection-key-rejection.js';
export { InvalidTokenLabelError, TokenNotFoundError, TokenStillActiveError } from './external-api-key.errors.js';
export type { IExternalApiKeyService, KeyKindSpec, MintedExternalApiKey } from './external-api-key.interface.js';
import './external-api-key.interface.js';
export type { InternalTokenService } from './internal-token.service.js';
export type { ILlmUsageMeter } from './llm-usage-meter.js';
export { createTokenVerifier, requireExternalSource, requireInternalSource } from './tool-auth.middleware.js';
export type { ConnectionChoices, ToolAuth } from './tool-auth.middleware.js';
import './tool-auth.middleware.js';
