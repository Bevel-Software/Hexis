import { describe, expect, it } from 'vitest';
import { parseLegacyChangeRequestBody } from '@bevel-software/platform-shared';

/**
 * The grammar bodies carried before a request's body became its description:
 * the generated `## Affected owners` block, an access request's level and
 * note in hidden markers, and identity markers. `moveLegacyRequestBodies`
 * reads every stored body through this once; what it keeps and what it moves
 * is pinned here.
 */
const GENERATED = [
  '## Affected owners',
  '',
  '- `KnowledgeBase/Engineering/Knowledge/Avi-Checkin.md` — Admin',
  '- `KnowledgeBase/GTM/Notes.md` — GTM Team',
].join('\n');

describe('parseLegacyChangeRequestBody', () => {
  it('drops the generated owners block and keeps what the author typed', () => {
    expect(parseLegacyChangeRequestBody(`Please take a look.\n\n${GENERATED}`)).toEqual({
      description: 'Please take a look.',
      changed: true,
    });
    expect(parseLegacyChangeRequestBody(GENERATED)).toEqual({ description: '', changed: true });
  });

  it("keeps the author's own headings, cutting only the LAST owners heading", () => {
    const out = parseLegacyChangeRequestBody(`Lead.\n\n## Why now\n\nBecause.\n\n## Affected owners\n\nI mean the GTM ones.\n\n${GENERATED}`);
    expect(out.description).toBe('Lead.\n\n## Why now\n\nBecause.\n\n## Affected owners\n\nI mean the GTM ones.');
    expect(out.description).not.toContain('Avi-Checkin');
  });

  it("moves an access request's level and note out of the prose, keeping the quoted lines as prose", () => {
    const body = [
      '<!--hexis:access-request-level:owner-->',
      'Rita \\(rita@x\\.io\\) asked for **Owner** on Research\\.',
      '',
      'Note from Rita:',
      '',
      '<!--hexis:access-request-note-->',
      '> I maintain these pages \\*now\\*',
      '> and the index',
      '<!--/hexis:access-request-note-->',
      '',
      "Anyone who can edit this folder's access answers it.",
      '',
      GENERATED,
    ].join('\n');
    expect(parseLegacyChangeRequestBody(body)).toEqual({
      description: [
        'Rita \\(rita@x\\.io\\) asked for **Owner** on Research\\.',
        '',
        'Note from Rita:',
        '',
        '> I maintain these pages \\*now\\*',
        '> and the index',
        '',
        "Anyone who can edit this folder's access answers it.",
      ].join('\n'),
      accessRequestLevel: 'owner',
      accessRequestNote: 'I maintain these pages *now*\nand the index',
      changed: true,
    });
  });

  it('reads a level with no note, and a level alone', () => {
    expect(parseLegacyChangeRequestBody('<!--hexis:access-request-level:write-->\nAna asked for **Can edit**.')).toEqual({
      description: 'Ana asked for **Can edit**.',
      accessRequestLevel: 'write',
      changed: true,
    });
    expect(parseLegacyChangeRequestBody('<!--hexis:access-request-level:owner-->')).toEqual({
      description: '',
      accessRequestLevel: 'owner',
      changed: true,
    });
  });

  it("strips the identity markers older bodies carry, and only those — an author's own comment is prose", () => {
    expect(parseLegacyChangeRequestBody('<!-- bevel:author:abc123 -->\nMy reason.')).toEqual({
      description: 'My reason.',
      changed: true,
    });
    expect(parseLegacyChangeRequestBody('My reason.\n<!-- TODO: ask Mia about the title -->')).toEqual({
      description: 'My reason.\n<!-- TODO: ask Mia about the title -->',
      changed: false,
    });
  });

  it('leaves a body of the new shape alone', () => {
    expect(parseLegacyChangeRequestBody('P2 - Planned\n\nA multi-line\nreason.')).toEqual({
      description: 'P2 - Planned\n\nA multi-line\nreason.',
      changed: false,
    });
    expect(parseLegacyChangeRequestBody('')).toEqual({ description: '', changed: false });
  });

  it('counts a body it only trims as changed, so the stored text ends up exactly what is shown', () => {
    // The ends and runs of blank lines go; spaces inside a line are the author's.
    expect(parseLegacyChangeRequestBody('  Lead.  \n\n\n\nMore.\n')).toEqual({
      description: 'Lead.  \n\nMore.',
      changed: true,
    });
  });
});
