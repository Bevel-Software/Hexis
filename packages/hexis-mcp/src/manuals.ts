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
      out.push(callTemplateSerializer.validateDict(raw as Record<string, unknown>));
    } catch (err) {
      console.error(
        `[hexis-mcp] skipping local tool "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}
