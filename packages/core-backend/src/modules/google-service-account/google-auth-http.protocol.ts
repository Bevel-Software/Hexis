import { CommunicationProtocol, type CallTemplate, type IUtcpClient } from '@utcp/sdk';
import { HttpCommunicationProtocol, type HttpCallTemplate } from '@utcp/http';
import { isGoogleServiceAccountAuth } from './google-service-account.auth.js';
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
 * Put the service-account-aware protocol in place of the stock `http` one.
 * UTCP's protocol registry is process-wide and each client copies it when it
 * is built, so this runs in the composition root before any client exists.
 */
export function installGoogleServiceAccountAuth(tokens: IServiceAccountTokenSource): void {
  CommunicationProtocol.communicationProtocols['http'] = new GoogleAuthHttpProtocol(tokens);
}
