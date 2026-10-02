/**
 * The schema check for connected tools, and the memory of what it found.
 *
 * An AI client that is handed a tool whose input schema is not valid JSON
 * Schema drops that tool and says nothing: it is simply missing for the agent,
 * with nothing in Hexis to look at. So Hexis runs the same check itself, when a
 * server's tools are LOADED, and:
 *
 *  - keeps such a tool off every agent surface, so the agent's picture of what
 *    it can do matches what it can actually call;
 *  - remembers the finding for the people who manage that server, who are the
 *    only ones who can get it fixed (the tool page, `list_tool_setup`).
 *
 * WHEN it runs is the point. The verdict is remembered per DISTINCT SCHEMA, so
 * a server whose tools are unchanged costs one hash and one map lookup per
 * tool: the JSON Schema check happens when a server's tools are first loaded
 * and when a refresh brings a schema this process has not seen, and never on a
 * tool call — which re-derives the surface from those same unchanged schemas.
 *
 * It never REPAIRS anything. The proxy passes a connected server's schema
 * through as sent; an invalid one is reported, and the server's owner decides.
 */

import { createHash } from 'node:crypto';
import { inputSchemaDefect, schemaDefectMarker, type SchemaDefect } from '@bevel-software/platform-mcp-core';
import type { HiddenTool, HiddenToolSource } from '../../shared/hidden-tools.js';

/** What {@link ToolSchemaGuard.screen} needs of a freshly loaded tool. */
export interface ScreenedTool {
  /** The UTCP name (`<manual>.<server>.<tool>`) — how the tool repository knows it. */
  utcpName: string;
  /** The flattened name an agent addresses it by. */
  mcpName: string;
  /** The input schema exactly as the connected server sent it. */
  inputSchema: unknown;
}

/**
 * How many schema verdicts to remember. Each is a hash and a verdict, so the
 * cap is about a deployment that edits servers all day rather than about size;
 * past it the whole table is cleared instead of evicted entry by entry, since
 * the next load simply re-checks.
 */
const MAX_REMEMBERED_SCHEMAS = 5000;

export class ToolSchemaGuard implements HiddenToolSource {
  /** Verdict per distinct schema: `null` means valid, so `undefined` means unchecked. */
  private readonly verdicts = new Map<string, SchemaDefect | null>();
  /** Per manual, by catalog name. Replaced whole on each load — see `screen`. */
  private readonly hidden = new Map<string, HiddenTool[]>();

  /** `check` is injected only by tests, to observe how often the check runs. */
  constructor(private readonly check: (schema: unknown) => SchemaDefect | null = inputSchemaDefect) {}

  /**
   * Screen one server's freshly loaded tools, by the manual's CATALOG name.
   * Returns the tools to keep off the agent surfaces, keyed by UTCP name.
   *
   * The manual's findings are replaced WHOLE, so a server that corrected a
   * schema loses its marker on the next load with nothing to clear by hand —
   * and a server whose tools are all valid holds no entry at all.
   */
  screen(manual: string, tools: readonly ScreenedTool[]): Map<string, HiddenTool> {
    const found = new Map<string, HiddenTool>();
    for (const tool of tools) {
      const defect = this.verdict(tool.inputSchema);
      if (!defect) continue;
      found.set(tool.utcpName, {
        manual,
        name: tool.mcpName,
        path: defect.path,
        reason: defect.reason,
        marker: schemaDefectMarker(defect),
      });
    }
    if (found.size > 0) this.hidden.set(manual, [...found.values()]);
    else this.hidden.delete(manual);
    return found;
  }

  hiddenFor(manual: string): HiddenTool[] {
    return this.hidden.get(manual) ?? [];
  }

  /**
   * The finding for a tool an agent called by the name it would have been
   * offered under — the one case where a hidden tool has to answer for itself.
   */
  hiddenByAgentName(name: string): HiddenTool | undefined {
    for (const tools of this.hidden.values()) {
      const match = tools.find((t) => t.name === name);
      if (match) return match;
    }
    return undefined;
  }

  /** The check itself, once per distinct schema. */
  private verdict(schema: unknown): SchemaDefect | null {
    const key = createHash('sha1').update(JSON.stringify(schema) ?? 'undefined').digest('hex');
    const remembered = this.verdicts.get(key);
    if (remembered !== undefined) return remembered;
    const defect = this.check(schema);
    if (this.verdicts.size >= MAX_REMEMBERED_SCHEMAS) this.verdicts.clear();
    this.verdicts.set(key, defect);
    return defect;
  }
}
