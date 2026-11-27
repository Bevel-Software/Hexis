import { CommunicationProtocol, type CallTemplate, type IUtcpClient } from '@utcp/sdk';
import { HttpCommunicationProtocol, type HttpCallTemplate } from '@utcp/http';
import { isGoogleServiceAccountAuth } from './google-service-account.auth.js';
import { GoogleServiceAccountTokenSource } from './google-service-account.token-source.js';
import type { IServiceAccountTokenSource } from './service-account-token.contract.js';

/**
 * The stock UTCP `http` protocol, taught one more auth type. A call whose
 * template names `google_service_account` is handed to the stock protocol with
 * that auth swapped for the bearer token it resolves to (as `oauth2_user`,
 * which the stock protocol sends as `Authorization: Bearer <token>` and strips
 * on a cross-origin redirect). Every other call passes through untouched.
 *
 * Being the one `http` protocol of the process, it is also where a failure is
 * written to the log. The stock protocol prints the raw axios error, whose
 * request config and socket header carry the credentials the call was made
 * with (an `Authorization: Bearer <shared key>` three times over). Here a
 * failure is logged by its message, error class, code and HTTP status only, so
 * the error object, and the credentials in it, never reach stdout or stderr.
 */
export class GoogleAuthHttpProtocol extends HttpCommunicationProtocol {
  constructor(private readonly tokens: IServiceAccountTokenSource) {
    super();
    // `_logError` is the stock protocol's one error sink: tool calls, discovery
    // and OAuth token fetches all pass through it. It is private in the type
    // declarations, so it is replaced on the instance rather than overridden.
    // Checked, not assumed: a release that renamed it would otherwise put the
    // raw error back in the log without a word.
    const hooks = this as unknown as { _logError?: unknown };
    if (typeof hooks._logError !== 'function') {
      throw new Error('@utcp/http no longer exposes _logError; failed calls would log their credentials');
    }
    hooks._logError = (message: string, error: unknown): void => {
      console.error(`[HttpCommunicationProtocol Error] ${message} ${describeFailure(error)}`);
    };
  }

  override async callTool(
    caller: IUtcpClient,
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolCallTemplate: CallTemplate,
  ): Promise<unknown> {
    return super.callTool(caller, toolName, toolArgs, await this.withBearerToken(toolCallTemplate));
  }

  override async *callToolStreaming(
    caller: IUtcpClient,
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolCallTemplate: CallTemplate,
  ): AsyncGenerator<unknown, void, unknown> {
    yield* super.callToolStreaming(caller, toolName, toolArgs, await this.withBearerToken(toolCallTemplate));
  }

  private async withBearerToken(template: CallTemplate): Promise<CallTemplate> {
    const auth = (template as HttpCallTemplate).auth;
    if (!isGoogleServiceAccountAuth(auth)) return template;
    const accessToken = await this.tokens.accessToken(auth);
    return { ...template, auth: { auth_type: 'oauth2_user', access_token: accessToken } } as CallTemplate;
  }
}

/**
 * What may be said of a failed request: the error's class, its code and the
 * HTTP status. None of them can hold a request's headers, body or URL, which is
 * where a substituted secret travels. The error's message, the response body
 * and the request config are left out because they can (a refused lookup names
 * the host, a provider echoes the rejected key).
 */
function describeFailure(error: unknown): string {
  if (!error || typeof error !== 'object') return '(no error detail)';
  const { name, code, response } = error as { name?: unknown; code?: unknown; response?: { status?: unknown } };
  const parts: string[] = [];
  if (typeof name === 'string' && /^\w{1,64}$/.test(name)) parts.push(name);
  if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) parts.push(code);
  if (typeof response?.status === 'number') parts.push(`status ${response.status}`);
  return parts.length > 0 ? parts.join(' ') : '(no error detail)';
}

/**
 * Put the service-account-aware protocol in place of the stock `http` one,
 * minting tokens from `tokens`. Exported so a suite can answer for Google;
 * a process never needs to call it, since loading this module already has.
 */
export function installGoogleServiceAccountAuth(
  tokens: IServiceAccountTokenSource = new GoogleServiceAccountTokenSource(),
): void {
  CommunicationProtocol.communicationProtocols['http'] = new GoogleAuthHttpProtocol(tokens);
}

// Installed on module load, the way `@utcp/http` installs the protocol this
// one replaces: once per process, before any client exists (a client copies
// the registry when it is built). The import of `@utcp/http` above has already
// run its own registration by the time this line does, whatever order the
// importing module lists the two in. One token cache then serves the process;
// its entries are keyed by the key itself, so knowledge bases never share one.
installGoogleServiceAccountAuth();
