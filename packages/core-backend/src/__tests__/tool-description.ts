/**
 * What a client is shown of a tool description — the cut claude.ai makes and
 * the length a client counts — for a suite outside the tool registry that
 * checks its own tools' descriptions against them. They are the registry's
 * measures, not part of its entry: no other module's code needs them, so a
 * suite takes them from this fixture rather than widening the entry.
 */
export { CLIENT_SHORT_CUT, clientVisibleLength } from '../modules/tool-registry/description-length.js';
