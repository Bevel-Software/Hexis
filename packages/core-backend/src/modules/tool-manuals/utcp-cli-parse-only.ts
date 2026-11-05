/**
 * Registers the UTCP `cli` call-template type for PARSING ONLY, and takes the
 * executor away again.
 *
 * A `.tool` whose tools shell out (`git status`, `git push`) is how the local
 * MCP server gets a git surface without handing an agent a token. The hosted
 * platform still has to UNDERSTAND those files — it scans them, validates them,
 * lists them through `list_local_tools`, and serves the inline manual body to
 * the local server that will run it — so the `cli` serializer must be
 * registered here or every such file fails validation and drops out of the
 * catalog.
 *
 * What it must never do is RUN one. Agents write to the knowledge base, so
 * anyone who can land a `.tool` would otherwise have a shell on production.
 * `@utcp/cli`'s module-level `register()` installs two things — the call
 * template serializer and a `CliCommunicationProtocol` — and only the first is
 * wanted here, so the protocol is removed from the SDK's registry immediately
 * after the import that added it.
 *
 * That makes decision 8 of the AEL plan structural instead of procedural. The
 * `remote: false` forcing in `normalizeToolManual` keeps cli manuals out of the
 * hosted proxy's registration set, but this is the backstop underneath it: with
 * no `cli` protocol in the process, a cli template that reached a hosted client
 * by any route at all fails to dispatch rather than executing. Two independent
 * mechanisms, because one of them being wrong is a remote shell.
 *
 * Import this module for its side effect wherever `.tool` files are parsed;
 * import order does not matter, since the removal runs at module evaluation and
 * nothing dispatches during a scan.
 */
import '@utcp/cli';
import { CommunicationProtocol } from '@utcp/sdk';

/** The UTCP call-template type this module registers the serializer for. */
export const CLI_CALL_TEMPLATE_TYPE = 'cli';

delete (CommunicationProtocol.communicationProtocols as Record<string, unknown>)[CLI_CALL_TEMPLATE_TYPE];

/**
 * Whether this process could dispatch a `cli` call template. Always false in the
 * hosted platform — exported so the guarantee is assertable in a test rather
 * than only described in a comment.
 */
export function canExecuteCliTemplates(): boolean {
  return CommunicationProtocol.communicationProtocols[CLI_CALL_TEMPLATE_TYPE] !== undefined;
}

/**
 * True when any part of `doc` is a `cli` call template.
 *
 * Deep walk rather than a lookup at `tool_call_template.call_template_type`:
 * the field is nested differently across UTCP tool shapes, sub-manuals nest
 * templates inside templates, and the consequence of missing one is a shell
 * template in a manual marked remote-capable. Cheap, and a `.tool` is small.
 *
 * Cycle-safe. A YAML anchor aliased inside itself (`a: &x { self: *x }`)
 * parses to a genuinely cyclic object, and an unguarded walk overflows the
 * stack — which the callers catch, so the file would be dropped from the
 * catalog silently instead of being examined. A node already seen contributes
 * nothing new, so it is simply not re-entered.
 */
export function containsCliCallTemplate(doc: unknown): boolean {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some(walk);
    const obj = node as Record<string, unknown>;
    if (typeof obj.call_template_type === 'string' && obj.call_template_type.toLowerCase().trim() === CLI_CALL_TEMPLATE_TYPE) {
      return true;
    }
    return Object.values(obj).some(walk);
  };
  return walk(doc);
}
