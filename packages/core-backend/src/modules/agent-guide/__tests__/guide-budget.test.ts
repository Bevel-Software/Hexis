import { DEFAULT_KB_LAYOUT } from '@bevel-software/platform-shared';
import { toListedTool } from '@bevel-software/platform-mcp-core';
import { describe, expect, it } from 'vitest';
import { countTokens } from '../../../__tests__/tokens.js';
import { hexisCatalog } from '../../../__tests__/hexis-catalog.js';
import {
  PREFIXED_TOOLS,
  composeAgentInstructions,
  platformInstructions,
  prefixToolDescription,
} from '../../agent-instructions/index.js';
import { EXTERNAL_KB_MANUAL_NAME } from '../../tool-manuals/index.js';
import { CORE_SECTION_IDS, START_HERE_SECTION_ID, agentGuideSections, joinGuideSections } from '../agent-guide.js';
import {
  INSTRUCTIONS_TOKEN_BUDGET,
  SECTION_TOKEN_BUDGETS,
  TOOL_LIST_TOKEN_BUDGET,
  WHOLE_GUIDE_TOKEN_BUDGET,
} from '../guide-budget.js';

/**
 * The budgets in `guide-budget.ts`, measured with a real tokenizer on the
 * text an agent is actually handed: the sections as composed for a
 * deployment (default layout, a default branch named `main`), the handshake's
 * platform part, and the tool list as the hosted endpoint serves it. Each
 * failure names what grew and by how much, so the next reader does not have
 * to measure it by hand.
 */

const composed = () => agentGuideSections(DEFAULT_KB_LAYOUT, undefined, { defaultBranch: 'main' });

describe('the guide fits its token budgets', () => {
  it('gives every core section a budget, and no budget to a section that is gone', () => {
    const budgeted = Object.keys(SECTION_TOKEN_BUDGETS);
    expect(CORE_SECTION_IDS.filter((id) => !budgeted.includes(id)), 'sections without a budget').toEqual([]);
    expect(budgeted.filter((id) => !CORE_SECTION_IDS.includes(id)), 'budgets for sections that do not exist').toEqual([]);
  });

  it('keeps each section within its budget, the start section the tightest', async () => {
    const over = (await composed())
      .map((s) => ({ id: s.id, tokens: countTokens(s.body), budget: SECTION_TOKEN_BUDGETS[s.id]! }))
      .filter((s) => s.tokens > s.budget);
    expect(over, over.map((s) => `${s.id}: ${s.tokens} tokens (budget ${s.budget})`).join('\n')).toEqual([]);
    expect(SECTION_TOKEN_BUDGETS[START_HERE_SECTION_ID]).toBe(Math.min(...Object.values(SECTION_TOKEN_BUDGETS)));
  });

  it('keeps the whole guide within its budget', async () => {
    const tokens = countTokens(joinGuideSections(await composed()));
    expect(tokens, `the whole guide is ${tokens} tokens (budget ${WHOLE_GUIDE_TOKEN_BUDGET})`).toBeLessThanOrEqual(
      WHOLE_GUIDE_TOKEN_BUDGET,
    );
  });

  it('keeps the platform part of the handshake instructions within its budget', () => {
    const tokens = countTokens(platformInstructions(DEFAULT_KB_LAYOUT));
    expect(tokens, `the instructions are ${tokens} tokens (budget ${INSTRUCTIONS_TOKEN_BUDGET})`).toBeLessThanOrEqual(
      INSTRUCTIONS_TOKEN_BUDGET,
    );
  });

  it('keeps the tool list a client is served within its budget', async () => {
    // As `mcp.service.ts` lists it: each tool through `toListedTool` (its
    // `Call:` line and normalised schema), the purpose prefix on the four
    // knowledge-base tools, and the meta-tools as built for the endpoint.
    const { external, metaTools } = await hexisCatalog();
    const { toolPrefix } = composeAgentInstructions(null, DEFAULT_KB_LAYOUT);
    const listed = external.map((t) => {
      const entry = toListedTool({
        mcpName: t.name,
        utcpName: `${EXTERNAL_KB_MANUAL_NAME}.${t.name}`,
        description: t.description ?? '',
        inputSchema: (t.inputs ?? {}) as never,
        manualName: EXTERNAL_KB_MANUAL_NAME,
      })!;
      return PREFIXED_TOOLS.has(entry.name)
        ? { ...entry, description: prefixToolDescription(toolPrefix, entry.description) }
        : entry;
    });
    const served = [
      ...metaTools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: (t as { inputSchema?: unknown }).inputSchema })),
      ...listed,
    ];
    const perTool = served.map((t) => ({
      name: t.name,
      tokens: countTokens(t.name) + countTokens(t.description ?? '') + countTokens(JSON.stringify(t.inputSchema ?? {})),
    }));
    const total = perTool.reduce((sum, t) => sum + t.tokens, 0);
    const largest = [...perTool].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
    expect(
      total,
      `the tool list is ${total} tokens over ${served.length} tools (budget ${TOOL_LIST_TOKEN_BUDGET}); largest: ` +
        largest.map((t) => `${t.name} ${t.tokens}`).join(', '),
    ).toBeLessThanOrEqual(TOOL_LIST_TOKEN_BUDGET);
  });
});
