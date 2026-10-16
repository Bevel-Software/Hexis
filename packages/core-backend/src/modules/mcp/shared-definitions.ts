import { createHash } from 'node:crypto';
import type { CallTemplate, Tool as UtcpTool } from '@utcp/sdk';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import type { ProxiedTool } from '@bevel-software/platform-mcp-core';

/**
 * Tool definitions held once for every cached client that discovered the same
 * ones.
 *
 * Two hundred people whose catalogs are identical would otherwise hold two
 * hundred copies of the same descriptions and schemas: a client's repository
 * keeps what discovery parsed, and every build parses its own. After a build,
 * each manual's discovered tools are swapped for the first copy of identical
 * tools this process has seen, so the descriptions, schemas and call templates
 * are one object graph no matter how many clients point at it. A client keeps
 * only what is its own: the repository's per-tool shells, its variables and
 * its secrets loader.
 *
 * Identity is the CONTENT of the definitions, not the manual's name or its
 * template: the knowledge base's manual is filtered per caller, so two people
 * can get different tools from the same template, and only identical content
 * may be shared. Definitions are tool schemas and call TEMPLATES — `${VAR}`
 * placeholders, never a resolved value — so sharing them shares no secret.
 *
 * Nothing here is read back for correctness: a definition dropped from these
 * maps (they are bounded) only stops the NEXT build from sharing it.
 */
export class SharedDefinitions {
  private readonly byContent = new Map<string, unknown>();
  private readonly interfaceCaches = new Map<string, Map<string, string>>();

  /** `maxEntries` bounds each map; 0 shares nothing. */
  constructor(private readonly maxEntries = 1000) {}

  /**
   * The first-seen copy of `value` (by its JSON), or `value` itself when it is
   * the first. Kinds share no key space: a tool list and a listing could
   * otherwise serialise alike.
   */
  intern<T>(kind: string, value: T): T {
    const key = `${kind}\u0000${fingerprint(value)}`;
    const held = this.byContent.get(key);
    if (held !== undefined) {
      // Recently used goes last, so the first entry is the one to drop.
      this.byContent.delete(key);
      this.byContent.set(key, held);
      return held as T;
    }
    if (this.maxEntries <= 0) return value;
    bound(this.byContent, this.maxEntries);
    this.byContent.set(key, value);
    return value;
  }

  /**
   * Point `client`'s repository at shared definitions: every manual's tools,
   * and the client's cache of generated TypeScript interfaces.
   *
   * `rawTemplates` are the manuals as fetched, by the name they are registered
   * under. Registration stores the template AFTER variable substitution — for
   * a platform-hosted manual, with the bearer of the request that built the
   * client in its headers. Nothing calls through a stored template (each
   * tool's own template is substituted at call time), but a cached client
   * must hold no request's credential, so the stored template is put back to
   * its placeholders.
   */
  async share(client: CodeModeUtcpClient, rawTemplates: ReadonlyMap<string, CallTemplate>): Promise<void> {
    const repo = client.config.tool_repository;
    const templates = await repo.getManualCallTemplates();
    const everyTool: UtcpTool[] = [];
    for (const stored of templates) {
      const name = String(stored.name ?? '');
      const manual = await repo.getManual(name);
      if (!manual) continue;
      const tools = this.intern('tools', manual.tools);
      everyTool.push(...tools);
      const raw = rawTemplates.get(name);
      const template = raw ? ({ ...raw, name } as CallTemplate) : stored;
      await repo.saveManual(template, { ...manual, tools });
    }
    // `toolFunctionCache` is filled lazily by `tools_info` and every chain,
    // keyed by tool name and derived from the definitions alone. Shared by
    // every client holding the very same tool set, it is generated once for
    // all of them instead of once per person.
    (client as unknown as { toolFunctionCache: Map<string, string> }).toolFunctionCache = this.interfaceCache(
      fingerprint(everyTool),
    );
  }

  /** The flattened catalog a surface lists, shared the same way. */
  listing(tools: ProxiedTool[]): ProxiedTool[] {
    return this.intern('listing', tools);
  }

  /** The generated-interface cache of one exact tool set. */
  private interfaceCache(toolSet: string): Map<string, string> {
    let cache = this.interfaceCaches.get(toolSet);
    if (cache) {
      this.interfaceCaches.delete(toolSet);
    } else {
      cache = new Map();
      if (this.maxEntries <= 0) return cache;
      bound(this.interfaceCaches, this.maxEntries);
    }
    this.interfaceCaches.set(toolSet, cache);
    return cache;
  }
}

/** Make room for one more entry, dropping the least recently used. */
function bound(map: Map<string, unknown>, maxEntries: number): void {
  while (map.size >= maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
