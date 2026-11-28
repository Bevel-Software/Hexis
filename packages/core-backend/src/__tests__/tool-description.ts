/**
 * How the tool registry measures what a client is handed of a tool
 * description (`modules/tool-registry/description-length.ts`), for a module's
 * suite that holds its own tool's text to the same cut and cap.
 *
 * No product code outside the registry reads these measurements, so they are
 * not on its entry: an entry export used only by tests is a member exported
 * for testing. A suite outside the registry can import them from here instead
 * of from the registry's file.
 */
export { CLIENT_SHORT_CUT, clientVisibleLength } from '../modules/tool-registry/description-length.js';
