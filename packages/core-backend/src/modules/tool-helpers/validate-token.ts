import type { IExternalApiKeyService } from '../tool-auth/external-api-key.interface.js';
import { InternalTokenService } from '../tool-auth/internal-token.service.js';
import { createTokenVerifier } from '../tool-auth/tool-auth.middleware.js';
import { createToolContextResolver, type ToolContextDeps } from './tool-context.js';
import { ToolError, type ToolContext } from './tool.contract.js';

export interface ToolValidatorDeps extends ToolContextDeps {
  externalApiKeyService: IExternalApiKeyService;
  internalTokenService: InternalTokenService;
}

/**
 * The tool-author SDK entry point — framework-agnostic, no Express. Given a
 * bearer token (the value AFTER `Bearer `), it verifies the token and returns the
 * per-call `ToolContext` (user, scope, and lazy `getWorkspace()`/`getFilesystem()`
 * accessors). It does NOT take a branch: a tool that targets a specific branch
 * declares a `branch` input the model fills and passes it to
 * `getWorkspace(branch)` / `getFilesystem(branch)` — so a branchless tool never
 * deals with workspaces at all. Throws a `ToolError` (carrying an HTTP status) on
 * a bad/expired token or an auth-backend failure, so any framework can map it.
 *
 * A tool — ours hosted in-process, or a third-party marketplace plugin hosting
 * its own endpoint — calls exactly this:
 *
 *   const ctx = await validateToken(bearer);
 *   const fs = await ctx.getFilesystem(branch);   // branch only if the tool declares one
 *
 * It shares `createTokenVerifier` with the Express `toolAuth` middleware, so the
 * auth path is identical whether a request arrives through our router or a
 * plugin's own server.
 */
export type ValidateToken = (
  token: string | undefined,
  signal?: AbortSignal,
) => Promise<ToolContext>;

export function createToolValidator(deps: ToolValidatorDeps): ValidateToken {
  const verify = createTokenVerifier(deps.externalApiKeyService, deps.internalTokenService);
  const resolve = createToolContextResolver(deps);
  return async (token, signal) => {
    let result;
    try {
      result = await verify(token);
    } catch {
      throw new ToolError('Authentication backend unavailable', 500);
    }
    if (!result.ok) throw new ToolError(result.message, result.status);
    return resolve(result.auth, signal ?? new AbortController().signal);
  };
}
