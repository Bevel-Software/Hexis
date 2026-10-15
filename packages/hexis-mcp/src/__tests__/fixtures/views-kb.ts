import { vi } from 'vitest';

/**
 * A small knowledge base with one knowledge view, shared by the views tests:
 * an ontology of tasks and projects, a view page whose snapshot records its
 * mirror (so it reads live), and the KB tools a view catalog calls, faked
 * over those files.
 */

export const ONT = 'KnowledgeBase/Ops';
const TASK_TYPE = [
  '---',
  'nodeType: "[NodeType](../NodeType.md)"',
  '---',
  '# Name',
  '# Status',
  '# Project (link outbound)',
  '# Blocked By (link inbound)',
].join('\n');
const PROJECT_TYPE = ['---', 'nodeType: "[NodeType](../NodeType.md)"', '---', '# Name', '# Goal'].join('\n');

const task = (name: string, extra: string[] = []): string =>
  [
    '---',
    'nodeType: "[Task](../../NodeTypes/Task.md)"',
    `id: task-${name.toLowerCase()}`,
    'owner: "Juan <juan@bevel.software>"',
    '---',
    '# Name',
    name,
    '# Status',
    'open',
    ...extra,
  ].join('\n');

export const FILES: Record<string, string> = {
  [`${ONT}/NodeTypes/Task.md`]: TASK_TYPE,
  [`${ONT}/NodeTypes/Project.md`]: PROJECT_TYPE,
  [`${ONT}/Knowledge/Tasks/Bread.md`]: task('Bread', [
    '# Project',
    'For [Groceries](../Projects/Groceries.md).',
    '<details>',
    '<summary>Source of Information</summary>',
    '',
    '1. Binding Slack thread — the status (2026-09-29)',
    '</details>',
    '# Blocked By',
    'Waiting on [Dentist](task-dentist).',
    '# Notes',
    'Not a selected field.',
  ]),
  [`${ONT}/Knowledge/Tasks/Dentist.md`]: task('Dentist'),
  [`${ONT}/Knowledge/Projects/Groceries.md`]: [
    '---',
    'nodeType: "[Project](../../NodeTypes/Project.md)"',
    '---',
    '# Name',
    'Groceries',
    '# Goal',
    'Food',
  ].join('\n'),
};

/** A knowledge view page carrying `snapshot`. */
export const page = (snapshot: object): string =>
  `<!doctype html>\n<html><head><title>To-do list</title></head><body>` +
  `<script id="kb-snapshot">\nwindow.KB_SNAPSHOT = ${JSON.stringify(snapshot)};\n</script></body></html>`;

export const VIEW = 'KnowledgeBase/Juan/Dashboards/To-Do-List.html';

export const snapshotOnPage = {
  format: 'hexis-kb-snapshot/1',
  takenAt: '2026-10-01',
  nodes: {},
  selection: {
    type: ['Task'],
    fields: 'Name,Status',
    mirror: { branch: 'main', dirs: [`${ONT}/Knowledge`], deep: true, types: ['Task'], fields: ['Name', 'Status'] },
  },
};

/** The KB tools a view catalog calls, over FILES, with `pageHtml` at VIEW. */
export const fakeKb = (pageHtml: string) =>
  vi.fn(async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    const path = String(args.path ?? '').replace(/^knowledge-base\//, '');
    switch (tool) {
      case 'start_session':
        return { sessionId: 's-1' };
      case 'grep':
        return {
          matches: [
            { path: `knowledge-base/${VIEW}`, text: '<title>To-do list</title>' },
            { path: `knowledge-base/${VIEW}`, text: '<script id="kb-snapshot">' },
          ],
        };
      case 'read_file':
        if (path === VIEW) return { path, content: pageHtml };
        if (path in FILES) return { path, content: FILES[path] };
        throw new Error(`no ${path}`);
      case 'list_files': {
        const prefix = `${path}/`;
        const names = new Map<string, string>();
        for (const p of Object.keys(FILES)) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          names.set(rest.split('/')[0]!, rest.includes('/') ? 'directory' : 'file');
        }
        return { entries: [...names].map(([name, type]) => ({ name, type })) };
      }
      default:
        throw new Error(`unexpected ${tool}`);
    }
  });
