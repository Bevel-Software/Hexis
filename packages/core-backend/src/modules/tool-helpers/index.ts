/**
 * The tool-author SDK — everything needed to build a tool, in ONE import.
 * Internal tools use it today; it is the surface a third-party marketplace
 * plugin will code against (eventually shipped as a standalone `@bevel-software/tool-sdk`
 * package). A tool author never needs the registry internals, the Express
 * middleware, or the internal-token service — only what is re-exported here.
 *
 *   import { validateToken, toolDef, ToolError } from '<tool-sdk>';
 *
 *   // in your endpoint:
 *   const ctx = await validateToken(bearerToken, body);   // verify + resolve, throws ToolError
 *   const fs = await ctx.getFilesystem();                  // lock-aware (write) / read-only (read)
 *   const def = toolDef({ name, description, inputs, path }); // self-describing UTCP Tool to register
 */
export { createToolValidator, type ValidateToken, type ToolValidatorDeps } from './validate-token.js';
export { toolDef, type ToolDefSpec } from './tool-def.js';
export { ToolError, hasHttpStatus, type ToolContext, type ToolHandler } from './tool.contract.js';
export type { JsonSchema, UtcpTool } from '../tool-registry/tool.contract.js';
