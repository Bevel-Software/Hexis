import { CallTemplateSerializer, type CallTemplate } from '@utcp/sdk';
import type { RawManual } from './deployment.js';

const callTemplateSerializer = new CallTemplateSerializer();

/**
 * The UTCP manual namespace the deployment's own tools register under. Tools
 * from this manual keep their bare names (`read_file`, not `hexis_read_file`),
 * so a skill or a habit that names a tool reads the same whether an agent is
 * connected to the hosted endpoint or to this one.
 */
export const REMOTE_MANUAL_NAME = 'hexis';

/**
 * The deployment's MCP endpoint, as one UTCP manual.
 *
 * This is the whole of the "bridge". The hosted endpoint is an MCP server and
 * UTCP speaks MCP as a transport, so re-exposing every remote tool is a manual
 * entry rather than a second client implementation — and, more importantly,
 * every remote tool keeps EXECUTING on the server. That is what keeps vault
 * secrets and completed OAuth sign-ins working: a `.tool` calling Notion or a
 * vendor API resolves its `${VAR}`s in the process that holds the client, and
 * for those tools that process stays the deployment's.
 */
export function remoteManualTemplate(mcpUrl: string, connectionKey: string): CallTemplate {
  return callTemplateSerializer.validateDict({
    name: REMOTE_MANUAL_NAME,
    call_template_type: 'mcp',
    config: {
      mcpServers: {
        [REMOTE_MANUAL_NAME]: {
          transport: 'http',
          url: mcpUrl,
          headers: { Authorization: `Bearer ${connectionKey}` },
          timeout: 60,
          sse_read_timeout: 300,
          terminate_on_close: true,
        },
      },
    },
  });
}

/**
 * Validate the local-only manuals into call templates, dropping any that fail.
 *
 * One malformed `.tool` must not cost the caller their whole toolset, so a
 * manual that will not validate is logged by name and skipped — the same
 * isolation the hosted proxy applies, for the same reason.
 */
export function localManualTemplates(
  manuals: RawManual[],
  localOnlyNames: ReadonlySet<string>,
): CallTemplate[] {
  const out: CallTemplate[] = [];
  for (const raw of manuals) {
    const name = typeof raw?.name === 'string' ? raw.name : '';
    if (!localOnlyNames.has(name)) continue;
    try {
      const template = callTemplateSerializer.validateDict(raw as Record<string, unknown>);
      // The deployment hands a `.tool` manual over as an http REFERENCE (a
      // template that fetches `/api/tools/<slug>/manual`), and UTCP's
      // secure-by-default rule limits a manual's tools to the protocol of the
      // template that registered it. Left alone, that dropped every `cli`
      // tool in a local `.tool` with a per-tool warning nobody sees — a `git`
      // manual "registered with 0 tools", and no session ever had `git.push`.
      // Widening to `cli` HERE is the design, not a bypass: the deployment
      // refuses to execute cli (it strips the executor from its own
      // registry), and this process exists precisely to be where those tools
      // run. The reference is platform-authored and fetched over the
      // authenticated channel to the caller's own deployment; the rule keeps
      // its force everywhere else — the remote manual is untouched, any
      // template that declares its own list (even an empty one) is respected
      // as-is, and a local manual that is a genuine http integration rather
      // than a platform reference keeps the strict default: the widening keys
      // on the reference's own URL shape, not merely on being http.
      const url = (template as { url?: unknown }).url;
      const isPlatformToolReference =
        template.call_template_type === 'http' &&
        typeof url === 'string' &&
        /\/api\/tools\/[^/]+\/manual$/.test(url.split('?')[0]!);
      if (isPlatformToolReference && template.allowed_communication_protocols == null) {
        template.allowed_communication_protocols = ['cli', 'http'];
      }
      out.push(template);
    } catch (err) {
      console.error(
        `[hexis-mcp] skipping local tool "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}
