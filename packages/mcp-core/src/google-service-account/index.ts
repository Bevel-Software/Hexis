// Importing this module registers the `google_service_account` auth type with
// UTCP and puts the `http` protocol that acts on it in place of the stock one.
export {
  isGoogleServiceAccountAuth,
  findUnservedGoogleServiceAccountAuth,
  holdsLiteralGoogleServiceAccountKey,
} from './google-service-account.auth.js';
export { GoogleAuthHttpProtocol, installGoogleServiceAccountAuth } from './google-auth-http.protocol.js';
export { GoogleServiceAccountTokenSource, GOOGLE_TOKEN_URL } from './google-service-account.token-source.js';
export {
  GOOGLE_SERVICE_ACCOUNT_AUTH_TYPE,
  ServiceAccountAuthError,
  type GoogleServiceAccountAuth,
  type IServiceAccountTokenSource,
} from './service-account-token.contract.js';
