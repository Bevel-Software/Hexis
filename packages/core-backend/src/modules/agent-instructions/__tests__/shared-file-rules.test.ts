import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_KB_LAYOUT, LEGACY_AGENTS_FILE, PREAMBLE_CAP } from '@bevel-software/platform-shared';
import { describe, expect, it } from 'vitest';
import { defaultKbTemplateDir } from '../../../assets.js';
import { renderTemplateText, SHARED_FILE_RULES_PLACEHOLDER } from '../../workspace/startup/steps/template-source.js';
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
  sharedRulesPointer,
} from '../shared-file-rules.js';

/**
 * The rules every file tool shares are stated in TWO places — the handshake
 * `instructions` and the platform-managed agent guide — and in neither tool
 * description. These tests are what makes "stated once" true: the two places
 * carry the SAME string, built from one text, so a rule cannot be changed in one
 * and left stale in the other.
 */

/** The packaged template's agent guide, as it ships (placeholders unrendered). */
async function guideTemplate(): Promise<string> {
  return readFile(path.join(defaultKbTemplateDir(), LEGACY_AGENTS_FILE), 'utf8');
}

describe('the shared file rules are one text, in two places', () => {
  it('puts the identical section in the handshake instructions and in the managed guide', async () => {
    const section = sharedFileRulesSection(DEFAULT_KB_LAYOUT);
    expect(section.startsWith(`## ${SHARED_RULES_SECTION}\n\n`)).toBe(true);

    const instructions = composeAgentInstructions(null).instructions;
    expect(instructions).toContain(section);

    const guide = renderTemplateText(await guideTemplate(), DEFAULT_KB_LAYOUT);
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
    const guide = renderTemplateText(await guideTemplate(), DEFAULT_KB_LAYOUT);
    const rules = sharedFileRules(DEFAULT_KB_LAYOUT);
    expect(rules.map((r) => r.id)).toEqual([
      'agent-guide',
      'content-kinds',
      'write-mode',
      'images-in-pages',
      'escape-sequences',
      'dry-run-confirm',
      'managed-items',
      'refused-for-permissions',
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
    for (const text of [composeAgentInstructions(null).instructions, renderTemplateText(await guideTemplate(), DEFAULT_KB_LAYOUT)]) {
      expect(text).toContain('`binary_not_writable`');
      expect(text).toContain('copy_file, move_file, delete_file and unzip act on bytes of any kind');
      expect(text).toContain('`request_upload_token` + `apply_upload`');
      expect(text).toContain('`contentMode`');
      expect(text).toContain('.docx/.pptx/.xlsx/.odt/.odp/.ods/.pdf');
      expect(text).toContain('.eml/.msg');
      expect(text).toContain('.doc/.ppt/.xls');
    }
  });

  it('names the guide under the name this deployment gave it, in both places and in the pointer', async () => {
    const layout = { ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' };
    const section = sharedFileRulesSection(layout);
    // Ours first, then the organisation's own AGENTS.md, then the pre-rename name.
    expect(section).toContain('read `HEXIS.md` at the KB root, then `AGENTS.md` if it also exists');
    expect(section).toContain('`CLAUDE.md` on a knowledge base seeded before it was renamed');
    // The platform files a move refuses list the guide under its own name too.
    expect(section).toContain('`HEXIS.md`');
    expect(composeAgentInstructions(null, layout).instructions).toContain(section);
    expect(renderTemplateText(await guideTemplate(), layout)).toContain(section);
    expect(sharedRulesPointer(layout)).toBe(` Shared rules for all file tools: see "${SHARED_RULES_SECTION}" in HEXIS.md.`);
  });

  it('points at the section with one short sentence under the default name', () => {
    expect(sharedRulesPointer(DEFAULT_KB_LAYOUT)).toBe(
      ' Shared rules for all file tools: see "Working with files" in AGENTS.md.',
    );
    // An unset guide name means the default, as it does everywhere else.
    expect(sharedRulesPointer({ ...DEFAULT_KB_LAYOUT, agentsFile: undefined })).toBe(
      sharedRulesPointer(DEFAULT_KB_LAYOUT),
    );
  });
});

describe('the guide template asks for the rules rather than repeating them', () => {
  it('carries the placeholder once, and no rule text of its own', async () => {
    const template = await guideTemplate();
    expect(template.split(SHARED_FILE_RULES_PLACEHOLDER)).toHaveLength(2);
    // The rules are not ALSO written into the template — that is the copy that
    // would drift. Checked on a fragment of each rule rather than on the whole.
    for (const rule of sharedFileRules(DEFAULT_KB_LAYOUT)) {
      expect(template, rule.id).not.toContain(rule.body.slice(0, 60));
    }
  });

  it('renders the placeholder nowhere else, so other managed files are untouched', async () => {
    const access = await readFile(path.join(defaultKbTemplateDir(), 'access.md'), 'utf8');
    expect(access).not.toContain(SHARED_FILE_RULES_PLACEHOLDER);
    expect(renderTemplateText(access, DEFAULT_KB_LAYOUT)).toBe(renderTemplateText(access, DEFAULT_KB_LAYOUT));
  });

  it('leaves no placeholder behind once rendered', async () => {
    const guide = renderTemplateText(await guideTemplate(), DEFAULT_KB_LAYOUT);
    expect(guide).not.toContain('{{');
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
