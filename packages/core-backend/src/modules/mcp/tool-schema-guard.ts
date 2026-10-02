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
 * A finding as the LOADING side needs it. The owner-facing `HiddenTool` is
 * about a tool by the name an agent would have called it; the proxy also has to
 * take the tool out of its repository and record it in the audit trail, and
 * both of those know a tool by its UTCP name. Kept off `HiddenTool` so the
 * owner-facing payload stays exactly what its surfaces declare.
 */
export interface ScreenedHiddenTool extends HiddenTool {
  /** The UTCP name (`<manual>.<server>.<tool>`) the tool repository knows it by. */
  utcpName: string;
}

/**
 * How many schema verdicts to remember. Each is a hash and a verdict, so the
 * cap is about a deployment that edits servers all day rather than about size;
 * past it the whole table is cleared instead of evicted entry by entry, since
 * the next load simply re-checks.
 */
const MAX_REMEMBERED_SCHEMAS = 5000;

/** How many callers' pictures to hold at once — see `screen` for what happens past it. */
const MAX_REMEMBERED_CALLERS = 2000;

export class ToolSchemaGuard implements HiddenToolSource {
  /** Verdict per distinct schema: `null` means valid, so `undefined` means unchecked. */
  private readonly verdicts = new Map<string, SchemaDefect | null>();
  /**
   * The findings, per CALLER and then per manual by catalog name.
   *
   * Keyed by caller because that is what a load is: discovery runs on the
   * requesting user's own connection to the server, and two callers can be
   * shown different tools by the same server. A single table keyed by manual
   * would let one caller's load erase another's finding — the owner page would
   * then show a defect from whichever request happened to be last, or none at
   * all. Keyed by caller, a load replaces only what that caller can see, and
   * `hiddenFor` reports the union, since the finding is about the server.
   */
  private readonly hidden = new Map<string, Map<string, ScreenedHiddenTool[]>>();
  /** The newest load whose picture has been applied, per caller — see {@link beginLoad}. */
  private readonly applied = new Map<string, number>();
  /** Hands out {@link beginLoad} tickets; monotonic for the life of the process. */
  private loads = 0;

  /** `check` is injected only by tests, to observe how often the check runs. */
  constructor(private readonly check: (schema: unknown) => SchemaDefect | null = inputSchemaDefect) {}

  /**
   * A ticket for a load that is ABOUT TO READ a server's tools, to be handed
   * back to {@link screen} with what it found.
   *
   * Requests overlap: a caller's surface is rebuilt on every one of them, and
   * two can be dialling the same server at once. Without an order, a load that
   * started while a schema was still broken could land after the load that saw
   * it corrected, and put the marker back on a tool that is fine — until some
   * later request happened to clear it again. The ticket is taken BEFORE the
   * read, so it ranks loads by the freshness of what they saw, and `screen`
   * ignores a picture older than the one already applied.
   */
  beginLoad(): number {
    this.loads += 1;
    return this.loads;
  }

  /**
   * Screen everything one caller's request just loaded — every manual on their
   * surface, with the tools that manual advertised — and replace that caller's
   * whole picture. Returns the tools to keep off the agent surfaces, keyed by
   * UTCP name.
   *
   * WHOLE is the point, and why this takes every manual rather than one. A
   * manual whose group is EMPTY has nothing hidden: its server dropped the
   * offending tool, or it failed to attach at all and its tools are not loaded.
   * A manual absent from `groups` is no longer on this caller's surface. Either
   * way the marker goes, with nothing to clear by hand — and nothing claims a
   * tool is hidden for a schema this process can no longer see.
   *
   * `loadId` comes from {@link beginLoad}, taken before the tools were read. A
   * load that is already out of date still gets its own answer — the request
   * that ran it must not offer a tool it has just judged invalid — but it does
   * not write that answer into what everyone else reads.
   */
  screen(
    userId: string,
    loadId: number,
    groups: ReadonlyMap<string, readonly ScreenedTool[]>,
  ): Map<string, ScreenedHiddenTool> {
    const found = new Map<string, ScreenedHiddenTool>();
    const picture = new Map<string, ScreenedHiddenTool[]>();
    for (const [manual, tools] of groups) {
      const ofManual: ScreenedHiddenTool[] = [];
      for (const tool of tools) {
        const defect = this.verdict(tool.inputSchema);
        if (!defect) continue;
        const hidden: ScreenedHiddenTool = {
          manual,
          name: tool.mcpName,
          utcpName: tool.utcpName,
          path: defect.path,
          reason: defect.reason,
          marker: schemaDefectMarker(defect),
        };
        found.set(tool.utcpName, hidden);
        ofManual.push(hidden);
      }
      if (ofManual.length > 0) picture.set(manual, ofManual);
    }
    // Stale: a load that read the server earlier than one already applied. Its
    // own answer stands, the shared picture does not move.
    if (loadId < (this.applied.get(userId) ?? 0)) return found;
    // Not about size — each entry is a handful of strings — but about a
    // deployment with many callers never growing these without bound. Cleared
    // whole rather than evicted one by one: the next load of each surface puts
    // its own findings back, and a ticket is monotonic, so a cleared order is
    // still an order.
    if (this.applied.size >= MAX_REMEMBERED_CALLERS && !this.applied.has(userId)) {
      this.hidden.clear();
      this.applied.clear();
    }
    this.applied.set(userId, loadId);
    if (picture.size > 0) this.hidden.set(userId, picture);
    else this.hidden.delete(userId);
    return found;
  }

  hiddenFor(manual: string): HiddenTool[] {
    const union = new Map<string, HiddenTool>();
    for (const picture of this.hidden.values()) {
      for (const { manual: of, name, path, reason, marker } of picture.get(manual) ?? []) {
        // One entry per distinct defect: two callers shown the same broken tool
        // have found one thing, and its owner should read it once. Projected to
        // the owner-facing shape, so nothing of the loading side rides along.
        union.set(`${name}\u0000${path}\u0000${reason}`, { manual: of, name, path, reason, marker });
      }
    }
    return [...union.values()];
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
