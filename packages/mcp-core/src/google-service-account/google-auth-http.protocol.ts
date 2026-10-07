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
 */
export class GoogleAuthHttpProtocol extends HttpCommunicationProtocol {
  constructor(private readonly tokens: IServiceAccountTokenSource) {
    super();
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
