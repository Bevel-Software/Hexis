/**
 * The page entry `sandboxed-document.ts` bundles: the REAL frame builder and
 * sanitizer, run in the browser that loads the frame. The builder reads the
 * document with the browser's own parser to list the scripts the frame may
 * run, so a document built anywhere else would be read by a different parser
 * than the frame's.
 */
import { buildSandboxedHtml, sanitizeAgentHtml } from '../../src/modules/workspace/components/renderers/htmlSandbox';

declare global {
  interface Window {
    htmlSandbox: { buildSandboxedHtml: typeof buildSandboxedHtml; sanitizeAgentHtml: typeof sanitizeAgentHtml };
  }
}

window.htmlSandbox = { buildSandboxedHtml, sanitizeAgentHtml };
