import { describe, it, expect } from 'vitest';
import {
  deniedSentence,
  failureReason,
  isDenial,
  nearestRuleFolder,
  readErrorLead,
} from '../utils/readFailure';
import { WorkspaceApiError } from '../../workspace/services/workspace.api';
import { GitApiError } from '../../git/services/git.api';

/**
 * The two sentences a failed read can produce, and the facts they are built
 * from. Kept as a unit test beside the dialog's own: the wording is the
 * ticket, and it should be pinned somewhere a render failure cannot hide it.
 */

describe('classifying a failed read', () => {
  it('reads 403 as a denial, whichever API client threw it', () => {
    expect(isDenial(new WorkspaceApiError(403))).toBe(true);
    expect(isDenial(new GitApiError(403, 'nope'))).toBe(true);
  });

  it('reads everything else as an error — including a read that never landed', () => {
    expect(isDenial(new WorkspaceApiError(404))).toBe(false);
    expect(isDenial(new WorkspaceApiError(500))).toBe(false);
    expect(isDenial(new TypeError('Failed to fetch'))).toBe(false);
    expect(isDenial(undefined)).toBe(false);
  });

  it("uses the server's own words as the reason, and says so when there are none", () => {
    expect(failureReason(new GitApiError(500, 'the workspace clone is missing'))).toBe(
      'the workspace clone is missing',
    );
    expect(failureReason(new WorkspaceApiError(500))).toBe('HTTP 500');
    expect(failureReason({})).toBe('the request never completed');
  });
});

describe('naming the folder to ask about', () => {
  const ancestor = (path: string) => ({ kind: 'ancestor' as const, path });

  it('takes the NEAREST ancestor rule — resolution is closeness-first', () => {
    expect(
      nearestRuleFolder({
        'u:ali@example.com': { read: [ancestor('Knowledge/access.md')] },
        'r:admin': { owner: [ancestor('Knowledge/Finance/Payroll/access.md')] },
      }),
    ).toBe('Knowledge/Finance/Payroll');
  });

  it('calls a rule at the repository root the whole workspace, not an empty name', () => {
    expect(deniedSentence(nearestRuleFolder({ 'r:admin': { read: [ancestor('access.md')] } }))).toBe(
      "You don't have access to read this file, so its content can't be shown here. " +
        'Ask an owner of the whole workspace for read access if you need to review it.',
    );
  });

  it('names nothing when the only rule is the file\'s own frontmatter', () => {
    expect(nearestRuleFolder({ 'u:ali@example.com': { read: [{ kind: 'direct' }] } })).toBeNull();
    expect(nearestRuleFolder({})).toBeNull();
    expect(nearestRuleFolder(undefined)).toBeNull();
  });
});

describe('the sentences themselves', () => {
  it('says access, names the folder, and never says "honest"', () => {
    const sentence = deniedSentence('Knowledge/Finance');
    expect(sentence).toBe(
      "You don't have access to read this file, so its content can't be shown here. " +
        'Ask an owner of Knowledge/Finance for read access if you need to review it.',
    );
    expect(sentence).not.toMatch(/honest/);
  });

  it('falls back to "this file" when no folder can be named', () => {
    expect(deniedSentence(null)).toContain('Ask an owner of this file for read access');
  });

  it('carries the reason of a read that merely broke, and never says "honest"', () => {
    const lead = readErrorLead('HTTP 500');
    expect(lead).toBe("This file couldn't be read right now (HTTP 500).");
    expect(lead).not.toMatch(/honest/);
  });
});
