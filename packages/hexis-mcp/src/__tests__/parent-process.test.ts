import { describe, expect, it } from 'vitest';
import { guessAgentFromAncestry, type ProcessRow } from '../parent-process.js';

const table = (rows: ProcessRow[]) => async () => rows;

describe('guessing the agent from the process tree', () => {
  it('names the nearest agent above the plumbing, as Claude Code inside VS Code spawns it on Windows', async () => {
    // The real chain on a Windows laptop: VS Code → Claude Code's native
    // binary → cmd → pwsh → cmd → node (npx) → node (this server).
    const rows: ProcessRow[] = [
      { pid: 100, ppid: 1, name: 'explorer.exe', command: 'C:\\WINDOWS\\Explorer.EXE' },
      { pid: 200, ppid: 100, name: 'Code.exe', command: '"C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"' },
      { pid: 300, ppid: 200, name: 'claude.exe', command: 'c:\\Users\\x\\.vscode\\extensions\\anthropic.claude-code-2.1.289-win32-x64\\resources\\native-binary\\claude.exe --output-format stream-json' },
      { pid: 400, ppid: 300, name: 'cmd.exe', command: 'C:\\WINDOWS\\System32\\cmd.exe /d /s /c ""C:\\WINDOWS\\System32\\chcp.com" 65001 >nul & npx -y @bevel-software/hexis-mcp@latest"' },
      { pid: 500, ppid: 400, name: 'node.exe', command: 'node "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" -y @bevel-software/hexis-mcp@latest' },
      { pid: 600, ppid: 500, name: 'node.exe', command: 'node C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\3e12\\node_modules\\@bevel-software\\hexis-mcp\\dist\\cli.js' },
    ];
    // Claude Code, not the VS Code it runs inside: the nearest agent wins.
    expect(await guessAgentFromAncestry(500, table(rows))).toEqual({ name: 'claude', guessed: true });
  });

  it('reads a runtime by what it runs: Claude Code installed with npm is node running its package', async () => {
    const rows: ProcessRow[] = [
      { pid: 1, ppid: 0, name: '/sbin/launchd', command: '/sbin/launchd' },
      { pid: 20, ppid: 1, name: '/Applications/iTerm.app/Contents/MacOS/iTerm2', command: '/Applications/iTerm.app/Contents/MacOS/iTerm2' },
      { pid: 30, ppid: 20, name: 'zsh', command: '-zsh' },
      { pid: 40, ppid: 30, name: 'node', command: 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
      { pid: 50, ppid: 40, name: 'node', command: 'npm exec @bevel-software/hexis-mcp@latest' },
      { pid: 60, ppid: 50, name: 'node', command: 'node /Users/x/.npm/_npx/abc/node_modules/.bin/hexis-mcp' },
    ];
    expect(await guessAgentFromAncestry(50, table(rows))).toEqual({ name: 'claude', guessed: true });
    // The bin shim spells it `…/bin/claude`; same answer.
    rows[3] = { pid: 40, ppid: 30, name: 'node', command: 'node /opt/homebrew/bin/claude' };
    expect(await guessAgentFromAncestry(50, table(rows))).toEqual({ name: 'claude', guessed: true });
    // Codex via npx, the same way.
    rows[3] = { pid: 40, ppid: 30, name: 'node', command: 'node /Users/x/.npm/_npx/9f1/node_modules/@openai/codex/bin/codex.js' };
    expect(await guessAgentFromAncestry(50, table(rows))).toEqual({ name: 'codex', guessed: true });
  });

  it('names a macOS app by its bundle, whatever the binary inside is called', async () => {
    const rows: ProcessRow[] = [
      { pid: 1, ppid: 0, name: '/sbin/launchd' },
      { pid: 20, ppid: 1, name: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron' },
      { pid: 30, ppid: 20, name: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)' },
      { pid: 40, ppid: 30, name: 'node', command: 'npm exec @bevel-software/hexis-mcp@latest' },
      { pid: 50, ppid: 40, name: 'node' },
    ];
    expect(await guessAgentFromAncestry(40, table(rows))).toEqual({ name: 'code', guessed: true });
    rows[1] = { pid: 20, ppid: 1, name: '/Applications/Cursor.app/Contents/MacOS/Cursor' };
    rows[2] = { pid: 30, ppid: 20, name: '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)' };
    expect(await guessAgentFromAncestry(40, table(rows))).toEqual({ name: 'cursor', guessed: true });
  });

  it('answers null when nothing above it is an agent it knows — a terminal, a daemon or a script is not a guess', async () => {
    const terminal: ProcessRow[] = [
      { pid: 100, ppid: 1, name: 'WindowsTerminal.exe' },
      { pid: 200, ppid: 100, name: 'pwsh.exe' },
      { pid: 300, ppid: 200, name: 'node.exe', command: 'node "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" -y @bevel-software/hexis-mcp@latest' },
      { pid: 400, ppid: 300, name: 'node.exe' },
    ];
    expect(await guessAgentFromAncestry(300, table(terminal))).toBeNull();
    const remote: ProcessRow[] = [
      { pid: 1, ppid: 0, name: 'systemd' },
      { pid: 10, ppid: 1, name: 'sshd' },
      { pid: 20, ppid: 10, name: 'bash' },
      { pid: 30, ppid: 20, name: 'python3', command: 'python3 /srv/jobs/run_agent.py' },
      { pid: 40, ppid: 30, name: 'node', command: 'node /srv/node_modules/@bevel-software/hexis-mcp/dist/cli.js' },
    ];
    expect(await guessAgentFromAncestry(30, table(remote))).toBeNull();
  });

  it('does not take a runtime for an agent because of a path that merely contains the word', async () => {
    const rows: ProcessRow[] = [
      { pid: 10, ppid: 1, name: 'Terminal' },
      { pid: 20, ppid: 10, name: 'node', command: 'node /Users/x/claude/projects/tool/server.js' },
      { pid: 30, ppid: 20, name: 'node', command: 'node /Users/x/.claude/plugins/codex-notes/index.js' },
    ];
    expect(await guessAgentFromAncestry(30, table(rows))).toBeNull();
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
    for (let pid = 3; pid <= 40; pid++) rows.push({ pid, ppid: pid - 1, name: 'sh' });
    rows.push({ pid: 2, ppid: 1, name: 'Windsurf' });
    expect(await guessAgentFromAncestry(40, table(rows), 8)).toBeNull();
    expect(await guessAgentFromAncestry(40, table(rows), 50)).toEqual({ name: 'windsurf', guessed: true });
  });
});
