import { describe, expect, it } from 'vitest';
import { guessAgentFromAncestry, type ProcessRow } from '../parent-process.js';

const table = (rows: ProcessRow[]) => async () => rows;

describe('guessing the agent from the process tree', () => {
  it('walks past cmd, npx and node to the program that spawned them, as Claude Code spawns it on Windows', async () => {
    const rows: ProcessRow[] = [
      { pid: 100, ppid: 1, name: 'explorer.exe' },
      { pid: 200, ppid: 100, name: 'claude.exe' },
      { pid: 300, ppid: 200, name: 'cmd.exe' },
      { pid: 400, ppid: 300, name: 'node.exe' }, // npx-cli.js
      { pid: 500, ppid: 400, name: 'cmd.exe' },
      { pid: 600, ppid: 500, name: 'node.exe' }, // this server
    ];
    expect(await guessAgentFromAncestry(500, table(rows))).toEqual({ name: 'claude', guessed: true });
  });

  it('takes the program name off a full path, as ps reports it on macOS', async () => {
    const rows: ProcessRow[] = [
      { pid: 1, ppid: 0, name: 'launchd' },
      { pid: 20, ppid: 1, name: '/Applications/Cursor.app/Contents/MacOS/Cursor' },
      { pid: 30, ppid: 20, name: 'node' },
      { pid: 40, ppid: 30, name: 'node' },
    ];
    // `readProcessTable` already strips the path; a table that did not is handled the same way.
    expect(await guessAgentFromAncestry(30, table(rows))).toEqual({ name: 'Cursor', guessed: true });
  });

  it('answers null when only plumbing is above it', async () => {
    const rows: ProcessRow[] = [
      { pid: 1, ppid: 0, name: 'systemd' },
      { pid: 10, ppid: 1, name: 'bash' },
      { pid: 20, ppid: 10, name: 'node' },
    ];
    expect(await guessAgentFromAncestry(10, table(rows))).toBeNull();
  });

  it('answers null when the table cannot be read, or the parent is not in it', async () => {
    expect(await guessAgentFromAncestry(10, table([]))).toBeNull();
    expect(await guessAgentFromAncestry(99, table([{ pid: 1, ppid: 0, name: 'init' }]))).toBeNull();
  });

  it('ends on a cycle instead of spinning', async () => {
    const rows: ProcessRow[] = [
      { pid: 10, ppid: 20, name: 'node' },
      { pid: 20, ppid: 10, name: 'npx' },
    ];
    expect(await guessAgentFromAncestry(10, table(rows))).toBeNull();
  });

  it('stops after a bounded number of hops', async () => {
    const rows: ProcessRow[] = [];
    for (let pid = 2; pid <= 40; pid++) rows.push({ pid, ppid: pid - 1, name: 'sh' });
    rows.push({ pid: 1, ppid: 0, name: 'Windsurf' });
    expect(await guessAgentFromAncestry(40, table(rows), 8)).toBeNull();
    expect(await guessAgentFromAncestry(40, table(rows), 50)).toBeNull(); // pid 1 is never asked
  });
});
