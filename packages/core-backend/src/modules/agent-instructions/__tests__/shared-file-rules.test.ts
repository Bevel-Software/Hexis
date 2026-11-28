import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { DEFAULT_KB_LAYOUT, PREAMBLE_CAP } from '@bevel-software/platform-shared';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { agentGuideSections, composeAgentGuide } from '../../agent-guide/index.js';
import { createAgentInstructionsRoutes } from '../agent-instructions.routes.js';
import {
  GUIDE_FIRST_LINE,
  INSTRUCTIONS_CAP,
  PLATFORM_HEADER,
  PREAMBLE_TRUNCATION_MARKER,
  SHARED_RULES_POINTER,
  composeAgentInstructions,
  platformInstructions,
} from '../compose.js';
import {
  SHARED_FILE_RULES_CAP,
  SHARED_RULES_SECTION,
  SHARED_RULES_SECTION_ID,
  sharedFileRules,
  sharedFileRulesSection,
} from '../shared-file-rules.js';

/**
 * The rules every file tool shares are stated in ONE place, the platform's
 * agent guide, and in no tool description. The handshake `instructions`
 * used to carry them as well, in front of the deployment's description, and
 * Claude Code cut the text before the description began; now the handshake
 * points at the guide section by the id `get_agent_guide` takes.
 */

describe('the shared file rules are one text, in the guide, and the handshake points at it', () => {
  it('serves the section under the id the handshake names, and leaves it out of the handshake', async () => {
    const section = sharedFileRulesSection(DEFAULT_KB_LAYOUT, '');
    expect(section.startsWith(`## ${SHARED_RULES_SECTION}\n\n`)).toBe(true);

    const served = (await agentGuideSections(DEFAULT_KB_LAYOUT)).find((s) => s.id === SHARED_RULES_SECTION_ID);
    expect(served?.body).toBe(section);
    expect(await composeAgentGuide(DEFAULT_KB_LAYOUT)).toContain(section);

    const instructions = composeAgentInstructions('We sell permits.').instructions;
    expect(instructions).not.toContain(`## ${SHARED_RULES_SECTION}`);
    expect(instructions.split(SHARED_RULES_POINTER)).toHaveLength(2);
    expect(SHARED_RULES_POINTER).toContain(`\`${SHARED_RULES_SECTION_ID}\``);
    expect(SHARED_RULES_POINTER).toContain('`get_agent_guide`');
  });

  it('states every rule in the guide, the content rule exactly once, and none in the handshake', async () => {
    const instructions = composeAgentInstructions('We sell permits.', 'main').instructions;
    const guide = await composeAgentGuide(DEFAULT_KB_LAYOUT);
    const rules = sharedFileRules(DEFAULT_KB_LAYOUT, '');
    expect(rules.map((r) => r.id)).toEqual([
      'agent-guide',
      'content-kinds',
      'workspace-tmp',
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
      expect(guide, rule.id).toContain(rule.body);
      for (const paragraph of rule.body.split('\n\n')) {
        expect(instructions, rule.id).not.toContain(paragraph);
      }
    }
    // Once, not twice: the rule used to arrive on a dozen tools at a time.
    const contentRule = rules.find((r) => r.id === 'content-kinds')!.body.split('\n\n')[0];
    expect(guide.split(contentRule)).toHaveLength(2);
  });

  it('carries the whole content rule — the refused families, the byte tools and the upload path', async () => {
    const text = await composeAgentGuide(DEFAULT_KB_LAYOUT);
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
  });

  /**
   * The guide is no file: it is reached by one name at the KB root and by one
   * tool, on every deployment. The first rule says so, and names the
   * organisation's own conventions file beside it — which is what a
   * `read_file` of that name serves first.
   */
  it('tells an agent to call get_agent_guide first, and that AGENTS.md answers with that start after the organisation\'s own', () => {
    const rule = sharedFileRules(DEFAULT_KB_LAYOUT).find((r) => r.id === 'agent-guide')!.body;
    expect(rule).toContain("call `get_agent_guide`: it answers the guide's start, which names the default branch");
    expect(rule).toContain('read_file on `AGENTS.md` at the KB root answers with that start');
    expect(rule).toContain("after the organisation's own conventions file of that name");
    // The pre-rename name is still offered, for a knowledge base that kept one.
    expect(rule).toContain('`CLAUDE.md`');
  });

  it('names one guide on every deployment, whatever name a deployment once saved for the written one', () => {
    const layout = { ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' };
    const section = sharedFileRulesSection(layout, '');
    expect(section).toBe(sharedFileRulesSection(DEFAULT_KB_LAYOUT, ''));
    expect(section).not.toContain('HEXIS.md');
    // The guide is not a platform file under any name: the list a move
    // refuses does not carry it.
    expect(section).toContain('`access.md` or `.bevelignore` in any folder, `roles.yaml` at the repository root');
  });

});

/**
 * The guide's start names the deployment's default branch, but only to an
 * agent that calls `get_agent_guide`; an agent left to guess guesses `main`,
 * and on a deployment whose default is another branch writes where nobody
 * reads. The conventions rule names it in the guide, and the handshake's
 * opening names it with the same sentence.
 */
describe('the default branch is named', () => {
  const SENTENCE =
    "This knowledge base's default branch is `target-company-state`: the branch people read and the usual target of a " +
    'change request; pass it as `branch` unless you are working on a draft.';

  /** The text under the "own conventions" heading, up to the next rule's heading. */
  const conventions = (text: string): string => {
    const start = text.indexOf("### This knowledge base's own conventions\n\n");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n### ', start + 1);
    return text.slice(start, end);
  };

  it('says the name in one sentence under "This knowledge base\'s own conventions"', () => {
    const section = sharedFileRulesSection(DEFAULT_KB_LAYOUT, 'target-company-state');
    expect(conventions(section)).toContain(SENTENCE);
    expect(section.split(SENTENCE)).toHaveLength(2);
    expect(section).not.toContain('`main`');
  });

  it('says whatever the name is — `main` on a deployment that uses it', () => {
    const rule = sharedFileRules(DEFAULT_KB_LAYOUT, 'main').find((r) => r.id === 'agent-guide')!.body;
    expect(rule).toContain(SENTENCE.replace('target-company-state', 'main'));
  });

  it('names no branch while the deployment has none', () => {
    const rule = sharedFileRules(DEFAULT_KB_LAYOUT, '').find((r) => r.id === 'agent-guide')!.body;
    expect(rule).not.toContain('default branch is');
  });

  it('keeps a name holding a backtick inside one code span', () => {
    // A valid ref name may carry a backtick; a plain span would end at it.
    const rule = sharedFileRules(DEFAULT_KB_LAYOUT, 'release`candidate').find((r) => r.id === 'agent-guide')!.body;
    expect(rule).toContain("default branch is ``release`candidate``: the branch");
    const edge = sharedFileRules(DEFAULT_KB_LAYOUT, '`main`').find((r) => r.id === 'agent-guide')!.body;
    expect(edge).toContain('default branch is `` `main` ``: the branch');
  });

  it('fits the caps with the longest branch name the platform accepts, so the caps are ceilings and not samples', () => {
    // kb-fs refuses a branch name over 255 characters; the caps are measured
    // with one of exactly that length, not with a typical name.
    const longest = 'b'.repeat(255);
    expect(sharedFileRulesSection(DEFAULT_KB_LAYOUT, longest).length).toBeLessThanOrEqual(SHARED_FILE_RULES_CAP);
    expect(composeAgentInstructions('x'.repeat(PREAMBLE_CAP * 2), longest).instructions.length).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
  });

  it('keeps a call that passes no branch working, naming none', () => {
    // The helpers are exported: a caller written before the branch was named
    // gets the text it got then, not a throw on an undefined name.
    expect(sharedFileRules(DEFAULT_KB_LAYOUT)).toEqual(sharedFileRules(DEFAULT_KB_LAYOUT, ''));
    expect(sharedFileRulesSection(DEFAULT_KB_LAYOUT)).toBe(sharedFileRulesSection(DEFAULT_KB_LAYOUT, ''));
    expect(platformInstructions()).toBe(platformInstructions(''));
  });

  it('carries the same sentence in the handshake instructions and in the managed guide', async () => {
    const instructions = composeAgentInstructions(null, 'target-company-state').instructions;
    const guide = await composeAgentGuide(DEFAULT_KB_LAYOUT, undefined, { defaultBranch: 'target-company-state' });
    expect(instructions.split(SENTENCE)).toHaveLength(2);
    expect(conventions(guide)).toContain(SENTENCE);
    expect(guide).toContain(sharedFileRulesSection(DEFAULT_KB_LAYOUT, 'target-company-state'));
  });

  it('names the renamed branch, and nothing else changes', async () => {
    const before = composeAgentInstructions(null, 'target-company-state').instructions;
    const after = composeAgentInstructions(null, 'company-state').instructions;
    expect(after).toContain(SENTENCE.replace('target-company-state', 'company-state'));
    expect(after).toBe(before.replaceAll('target-company-state', 'company-state'));
  });

  it('names the branch in effect on GET /agent/instructions, read per request', async () => {
    let branch = 'target-company-state';
    // Who may read the route is its own suite's question; here every caller passes.
    const app = express();
    app.use('/api', createAgentInstructionsRoutes((_req, _res, next) => next(), async () => null, () => branch));
    const server = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent/instructions`;
      const read = async () => ((await (await fetch(url)).json()) as { instructions: string }).instructions;
      const before = await read();
      expect(before).toBe(platformInstructions('target-company-state'));
      expect(before).toContain(SENTENCE);
      branch = 'company-state';
      expect(await read()).toBe(before.replaceAll('target-company-state', 'company-state'));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('the delete rule for platform files', () => {
  const managedItems = (): string => sharedFileRules(DEFAULT_KB_LAYOUT, '').find((r) => r.id === 'managed-items')!.body;

  it('says a nested access.md is deleted by whoever may write it, and the root\'s platform files by nobody', async () => {
    const body = managedItems();
    expect(body).toContain('delete_file deletes a nested `access.md` for whoever may write it');
    expect(body).toContain("its folder then follows its parent's rules");
    expect(body).toContain("the repository root's `access.md` and `roles.yaml` are deleted by nobody");
    // The sentence the refusal actually carries, as the tools and the app say it.
    expect(body).toContain("\"<name> is the repository's own file and cannot be deleted.\"");
    expect(await composeAgentGuide(DEFAULT_KB_LAYOUT)).toContain(body);
  });
});

describe('the handshake text stays inside the length it pins', () => {
  it('holds the shared section under its own cap, whatever the branch name', () => {
    // The sentence naming the default branch counts against the cap like any
    // rule; a 255-character name of backticks renders longest.
    for (const branch of ['', 'target-company-state', 'b'.repeat(255), '`'.repeat(255)]) {
      const section = sharedFileRulesSection(DEFAULT_KB_LAYOUT, branch);
      expect(
        section.length,
        `branch of ${branch.length}: the shared rules are ${section.length} characters (cap ${SHARED_FILE_RULES_CAP})`,
      ).toBeLessThanOrEqual(SHARED_FILE_RULES_CAP);
    }
  });

  it('is the length Claude Code keeps of a server\'s instructions', () => {
    // Claude Code 2.1.332 cuts server instructions past 4,096 characters
    // (2.1.293 cut at 2,048). A cap above the client's limit is text the
    // model never sees; this number moves only with a new measurement.
    expect(INSTRUCTIONS_CAP).toBe(4_096);
  });

  it('holds the worst-case instructions under that length, whatever the branch name', () => {
    // A 255-character name of backticks renders longest: a code span three
    // times its length. The opening + a preamble at ITS cap + the marker a
    // cut appends, with the blank line between them.
    for (const branch of ['', 'main', 'b'.repeat(255), '`'.repeat(255)]) {
      const worstCase = platformInstructions(branch).length + 2 + PREAMBLE_CAP + 1 + PREAMBLE_TRUNCATION_MARKER.length;
      expect(worstCase, `branch of ${branch.length}`).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
      // And what an actual over-long preamble produces is under it too.
      const composed = composeAgentInstructions('x'.repeat(PREAMBLE_CAP * 2), branch);
      expect(composed.truncated).toBe(true);
      expect(composed.instructions.length).toBeLessThanOrEqual(INSTRUCTIONS_CAP);
    }
  });

  it('puts the "when to use Hexis" opening and the description\'s start within the first 2,000 characters', () => {
    // 2,000 sits under the 2,048 an older Claude Code cut at, so the parts an
    // agent needs to pick Hexis survive that client too. Measured with the
    // longest plain branch name the platform accepts.
    const marker = 'QA-PRE-4410 Acme builds solar farms; permits live in Permitting/.';
    const description = `${marker}\n\n## Second section\n\n${'More about the folders. '.repeat(200)}`;
    for (const branch of ['', 'main', 'b'.repeat(255)]) {
      const head = composeAgentInstructions(description, branch).instructions.slice(0, 2_000);
      expect(head.startsWith(GUIDE_FIRST_LINE), `branch of ${branch.length}`).toBe(true);
      expect(head, `branch of ${branch.length}`).toContain(PLATFORM_HEADER);
      expect(head, `branch of ${branch.length}`).toContain(marker);
    }
  });

  it('hands the platform-owned text back as `header`, apart from the admin preamble', () => {
    const out = composeAgentInstructions('We sell permits.');
    expect(out.header).toBe(platformInstructions(''));
    expect(out.header).toContain(PLATFORM_HEADER);
    expect(out.header).toContain(SHARED_RULES_POINTER);
    expect(out.preamble).toBe('We sell permits.');
    expect(out.instructions).toBe(`${out.header}\n\nWe sell permits.`);
  });
});
