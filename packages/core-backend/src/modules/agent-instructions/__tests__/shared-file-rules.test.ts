import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_KB_LAYOUT,
  LEGACY_AGENTS_FILE,
  PREAMBLE_CAP,
  renderKbLayoutPlaceholders,
} from '@bevel-software/platform-shared';
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
  POINTER_GUIDE_NAME_BUDGET,
  SHARED_FILE_RULES_CAP,
  SHARED_RULES_POINTER_MAX,
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
    for (const text of [composeAgentInstructions(null).instructions, renderTemplateText(await guideTemplate(), DEFAULT_KB_LAYOUT)]) {
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

  it('keeps the pointer bounded whatever the guide is called', () => {
    // The pointer rides on every file tool, so its length is not the guide's
    // business: `validateFilename` allows a 255-byte name, and an unbounded
    // pointer would reach 318 characters and push `file_stat` past the
    // description cap — on a renamed deployment only, which no measurement
    // taken under the default layout would ever show.
    const nameOfLength = (n: number): string => `${'x'.repeat(n - 3)}.md`;
    for (const length of [9, POINTER_GUIDE_NAME_BUDGET, POINTER_GUIDE_NAME_BUDGET + 1, 120, 255]) {
      const pointer = sharedRulesPointer({ ...DEFAULT_KB_LAYOUT, agentsFile: nameOfLength(length) });
      expect(pointer.length, `a ${length}-character name`).toBeLessThanOrEqual(SHARED_RULES_POINTER_MAX);
    }
    // Up to the budget the file is NAMED, which is the better sentence.
    const named = nameOfLength(POINTER_GUIDE_NAME_BUDGET);
    expect(sharedRulesPointer({ ...DEFAULT_KB_LAYOUT, agentsFile: named })).toContain(named);
    // Past it the guide is named by its role instead — a sentence that still
    // says where to look, rather than a catalog entry the client cuts.
    const tooLong = nameOfLength(POINTER_GUIDE_NAME_BUDGET + 1);
    const fallback = sharedRulesPointer({ ...DEFAULT_KB_LAYOUT, agentsFile: tooLong });
    expect(fallback).not.toContain(tooLong);
    expect(fallback).toBe(` Shared rules for all file tools: see "${SHARED_RULES_SECTION}" in the agent guide at the KB root.`);
    // Either way the section's first rule still names the file, so the name is
    // never actually lost.
    expect(sharedFileRulesSection({ ...DEFAULT_KB_LAYOUT, agentsFile: tooLong })).toContain(tooLong);
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
    // So rendering it gains no rule text: whatever the layout renderer does to
    // its own tokens, the section is nowhere in the result.
    const rendered = renderTemplateText(access, DEFAULT_KB_LAYOUT);
    expect(rendered).not.toContain(sharedFileRulesSection(DEFAULT_KB_LAYOUT));
    expect(rendered).not.toContain(`## ${SHARED_RULES_SECTION}`);
  });

  it('leaves no placeholder behind once rendered', async () => {
    const guide = renderTemplateText(await guideTemplate(), DEFAULT_KB_LAYOUT);
    expect(guide).not.toContain('{{');
  });

  it('renders the layout tokens first, then injects the rules — so the rules are never re-rendered', async () => {
    // A layout the two orders DISAGREE on, which an ordinary one does not: the
    // section states the knowledge-base folder's name, so a deployment whose
    // folder is literally called `{{skillsDir}}` puts a layout token inside the
    // rendered section. Injecting first would then rewrite it on the second
    // pass and the guide would name the skills folder where the rule means the
    // knowledge-base one. Pathological on purpose: it is the only kind of input
    // on which the order is observable at all, which is why a test that pins
    // the order has to use one.
    const layout = { ...DEFAULT_KB_LAYOUT, knowledgeBaseDir: '{{skillsDir}}', skillsDir: 'Playbooks' };
    const section = sharedFileRulesSection(layout);
    expect(section).toContain('{{skillsDir}}/');

    const template = `Skills live in {{skillsDir}}/.\n\n${SHARED_FILE_RULES_PLACEHOLDER}\n`;
    const rendered = renderTemplateText(template, layout);
    // The author's token is rendered, and the section survives byte for byte.
    expect(rendered).toBe(`Skills live in Playbooks/.\n\n${section}\n`);

    // And the other order really does differ on this input, so the assertion
    // above is load-bearing rather than true of both.
    const injectedFirst = renderKbLayoutPlaceholders(
      template.replaceAll(SHARED_FILE_RULES_PLACEHOLDER, () => section),
      layout,
    );
    expect(injectedFirst).not.toBe(rendered);
    expect(injectedFirst).not.toContain(section);
    expect(injectedFirst).toContain('`Playbooks/`) and git metadata are refused');
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
