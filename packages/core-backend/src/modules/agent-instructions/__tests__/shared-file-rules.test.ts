import { DEFAULT_KB_LAYOUT, PREAMBLE_CAP } from '@bevel-software/platform-shared';
import { describe, expect, it } from 'vitest';
import { composeAgentGuide } from '../../agent-guide/agent-guide.js';
import {
  INSTRUCTIONS_CAP,
  PLATFORM_HEADER,
  PREAMBLE_TRUNCATION_MARKER,
  composeAgentInstructions,
  platformInstructions,
} from '../compose.js';
import {
  SHARED_FILE_RULES_CAP,
  SHARED_RULES_SECTION,
  sharedFileRules,
  sharedFileRulesSection,
} from '../shared-file-rules.js';

/**
 * The rules every file tool shares are stated in TWO places — the handshake
 * `instructions` and the platform's agent guide — and in neither tool
 * description. These tests are what makes "stated once" true: the two places
 * carry the SAME string, built from one text, so a rule cannot be changed in one
 * and left stale in the other.
 */

describe('the shared file rules are one text, in two places', () => {
  it('puts the identical section in the handshake instructions and in the agent guide', async () => {
    const section = sharedFileRulesSection(DEFAULT_KB_LAYOUT);
    expect(section.startsWith(`## ${SHARED_RULES_SECTION}\n\n`)).toBe(true);

    const instructions = composeAgentInstructions(null).instructions;
    expect(instructions).toContain(section);

    const guide = await composeAgentGuide(DEFAULT_KB_LAYOUT);
    expect(guide).toContain(section);

    // Byte-for-byte the same text in both, which is the whole point: neither is
    // a hand-written copy that could be edited on its own.
    const inGuide = guide.slice(guide.indexOf(section), guide.indexOf(section) + section.length);
    const inInstructions = instructions.slice(
      instructions.indexOf(section),
      instructions.indexOf(section) + section.length,
    );
    expect(inGuide).toBe(inInstructions);
  });

  it('states every rule in both places, and the content rule exactly once in each', async () => {
    const instructions = composeAgentInstructions(null).instructions;
    const guide = await composeAgentGuide(DEFAULT_KB_LAYOUT);
    const rules = sharedFileRules(DEFAULT_KB_LAYOUT);
    expect(rules.map((r) => r.id)).toEqual([
      'agent-guide',
      'content-kinds',
      'write-mode',
      'images-in-pages',
      'escape-sequences',
      'upload-route',
      'dry-run-confirm',
      'managed-items',
      'refused-for-permissions',
      'tool-chain',
    ]);
    for (const rule of rules) {
      expect(instructions, rule.id).toContain(rule.body);
      expect(guide, rule.id).toContain(rule.body);
    }
    // Once in each, not twice: the rule used to arrive on a dozen tools at a time.
    const contentRule = rules.find((r) => r.id === 'content-kinds')!.body.split('\n\n')[0];
    expect(instructions.split(contentRule)).toHaveLength(2);
    expect(guide.split(contentRule)).toHaveLength(2);
  });

  it('carries the whole content rule — the refused families, the byte tools and the upload path', async () => {
    for (const text of [composeAgentInstructions(null).instructions, await composeAgentGuide(DEFAULT_KB_LAYOUT)]) {
      expect(text).toContain('`binary_not_writable`');
      expect(text).toContain('copy_file, move_file and delete_file act on bytes of any kind');
      expect(text).toContain('unzip extracts the entries of a `.zip`');
      // The upload path by the names of the tools this deployment serves.
      expect(text).toContain('call `request_file_upload`');
      expect(text).toContain('then `apply_file_upload`');
      expect(text).not.toContain('request_upload_token');
      expect(text).toContain('`contentMode`');
      expect(text).toContain('.docx/.pptx/.xlsx/.odt/.odp/.ods/.pdf');
      expect(text).toContain('.eml/.msg');
      expect(text).toContain('.doc/.ppt/.xls');
    }
  });

  /**
   * The guide is no file: it is reached by one name at the KB root and by one
   * tool, on every deployment. The first rule says so, and names the
   * organisation's own conventions file beside it — which is what a
   * `read_file` of that name serves first.
   */
  it('tells an agent to call get_agent_guide first, and that AGENTS.md answers with the same guide after the organisation\'s own', () => {
    const rule = sharedFileRules(DEFAULT_KB_LAYOUT).find((r) => r.id === 'agent-guide')!.body;
    expect(rule).toContain("call `get_agent_guide` and read the platform's guide");
    expect(rule).toContain('read_file on `AGENTS.md` at the KB root answers with the same guide');
    expect(rule).toContain("after the organisation's own conventions file of that name");
    // The pre-rename name is still offered, for a knowledge base that kept one.
    expect(rule).toContain('`CLAUDE.md`');
  });

  it('names one guide on every deployment, whatever name a deployment once saved for the written one', () => {
    const layout = { ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' };
    const section = sharedFileRulesSection(layout);
    expect(section).toBe(sharedFileRulesSection(DEFAULT_KB_LAYOUT));
    expect(section).not.toContain('HEXIS.md');
    expect(composeAgentInstructions(null, layout).instructions).toContain(section);
    // The guide is not a platform file under any name: the list a move
    // refuses does not carry it.
    expect(section).toContain('`access.md` or `.bevelignore` in any folder, `roles.yaml` at the repository root');
  });

});

describe('the handshake text stays inside the length it pins', () => {
  it('holds the shared section under its own cap', () => {
    const section = sharedFileRulesSection(DEFAULT_KB_LAYOUT);
    expect(
      section.length,
      `the shared rules are ${section.length} characters (cap ${SHARED_FILE_RULES_CAP})`,
    ).toBeLessThanOrEqual(SHARED_FILE_RULES_CAP);
  });

  it('holds the worst-case instructions under the cap the caps add up to', () => {
    // Header + the shared rules at their cap + a preamble at ITS cap + the
    // marker a cut appends + the two blank lines between the three parts.
    const worstCase = PLATFORM_HEADER.length + 2 + SHARED_FILE_RULES_CAP + 2 + PREAMBLE_CAP + 1 + PREAMBLE_TRUNCATION_MARKER.length;
    expect(worstCase).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
    // And what an actual over-long preamble produces is under it too.
    const composed = composeAgentInstructions('x'.repeat(PREAMBLE_CAP * 2));
    expect(composed.truncated).toBe(true);
    expect(composed.instructions.length).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
  });

  it('hands the platform-owned text back as `header`, apart from the admin preamble', () => {
    const out = composeAgentInstructions('We sell permits.');
    expect(out.header).toBe(platformInstructions(DEFAULT_KB_LAYOUT));
    expect(out.header).toContain(PLATFORM_HEADER);
    expect(out.header).toContain(`## ${SHARED_RULES_SECTION}`);
    expect(out.preamble).toBe('We sell permits.');
    expect(out.instructions).toBe(`${out.header}\n\nWe sell permits.`);
  });
});
