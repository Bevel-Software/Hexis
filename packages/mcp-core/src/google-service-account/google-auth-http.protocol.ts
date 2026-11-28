import { CommunicationProtocol, type CallTemplate, type IUtcpClient, type RegisterManualResult } from '@utcp/sdk';
import { HttpCommunicationProtocol, type HttpCallTemplate } from '@utcp/http';
import { isGoogleServiceAccountAuth } from './google-service-account.auth.js';
import { GoogleServiceAccountTokenSource } from './google-service-account.token-source.js';
import type { IServiceAccountTokenSource } from './service-account-token.contract.js';
import { printable } from '../printable.js';

/**
 * The stock UTCP `http` protocol, taught one more auth type. A call whose
 * template names `google_service_account` is handed to the stock protocol with
 * that auth swapped for the bearer token it resolves to (as `oauth2_user`,
 * which the stock protocol sends as `Authorization: Bearer <token>` and strips
 * on a cross-origin redirect). Every other call passes through untouched.
 *
 * Being the one `http` protocol of the process, it is also what writes the
 * protocol's log lines, and the stock ones carry credentials: a failure prints
 * the raw axios error, whose request config and socket header hold the
 * `Authorization: Bearer <shared key>` three times over, and every call and
 * discovery prints its full URL, where a key written anywhere in it (the host,
 * the user info, the path, the query) travels. Here a URL is not logged at
 * all, and a failure by its message, error class, code and HTTP status only,
 * so neither reaches stdout or stderr; a refused discovery returns, for its
 * callers to print, its status and manual name only. Each message this
 * protocol writes is one `printable` token, so a tool or provider name cannot
 * forge or colour its lines (the UTCP client's own lines are its own).
 */
export class GoogleAuthHttpProtocol extends HttpCommunicationProtocol {
  constructor(private readonly tokens: IServiceAccountTokenSource) {
    super();
    // `_logInfo` and `_logError` are the stock protocol's two log sinks: tool
    // calls, discovery and OAuth token fetches all write through them. They are
    // private in the type declarations, so they are replaced on the instance
    // rather than overridden. Checked, not assumed: a release that renamed one
    // would otherwise put the credentials back in the log without a word.
    const hooks = this as unknown as Record<'_logInfo' | '_logError', unknown>;
    if (typeof hooks._logInfo !== 'function' || typeof hooks._logError !== 'function') {
      throw new Error('@utcp/http no longer exposes _logInfo and _logError; its log lines would carry credentials');
    }
    hooks._logInfo = (message: string): void => {
      console.log(`[HttpCommunicationProtocol] ${printable(withoutUrls(message))}`);
    };
    hooks._logError = (message: string, error: unknown): void => {
      console.error(`[HttpCommunicationProtocol Error] ${printable(withoutUrls(message))} ${describeFailure(error)}`);
    };
  }

  /**
   * A refused discovery answers its status and the manual's name, nothing
   * more. Its error text is printed as it is returned: by the UTCP client
   * (`Error registering manual …`) and by every Hexis caller that logs a
   * skipped manual, and the stock text carries the provider's rejection body
   * (which may echo the key) or a transport message (which names a host the
   * key may sit in). The class and code of the failure are in the log line
   * `_logError` has already written.
   */
  override async registerManual(caller: IUtcpClient, template: CallTemplate): Promise<RegisterManualResult> {
    const result = await super.registerManual(caller, template);
    if (result.success) return result;
    // Only the status is read from the stock text (a refusal opens `HTTP <status>`);
    // the name is the template's own, rendered whatever characters it holds.
    const manual = printable(String(template.name ?? ''));
    const errors = result.errors.map((error) => {
      const status = /^HTTP \d{3}\b/.exec(error)?.[0];
      return status ? `${status} discovering tools from ${manual}` : `discovering tools from ${manual} failed`;
    });
    return { ...result, errors };
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
 * A log line cut at its URL field. The stock lines that carry a URL carry it
 * as a field: `Discovering tools from '<name>' (HTTP) at <url>` and
 * `Executing HTTP tool '<name>' with URL: <url> and method: <method>`. The
 * URL is the template's, spelled as the template spells it (`http:/host`,
 * backslashes, a key in the host, a space), so it is not recognised by its
 * look: everything after the first ` at ` or ` with URL: ` becomes `<url>`.
 * A name that holds one of the two cuts the line earlier, never later. The
 * name stays, so the line still says what it concerns.
 */
function withoutUrls(message: string): string {
  return message.replace(/( at | with URL: )[\s\S]*/, '$1<url>');
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
