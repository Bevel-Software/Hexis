import { afterEach, describe, expect, test } from 'vitest';
import { readAt } from '../pending-proposals.js';
import { setLogger } from '../logging.js';
import type { ILogger } from '../logger.contract.js';
import type { WorkspaceService } from '../../modules/workspace/workspace.service.js';

/**
 * `readAt` is the one place a proposal's file is fetched, and every value it
 * handles is attacker-shaped: the path and the branch come off a change request
 * somebody else opened, and the failure reason comes off git.
 */

/** A logger that only records, so a test can read back the line that was written. */
function capturing(): { lines: string[]; impl: ILogger } {
  const lines: string[] = [];
  const impl: ILogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => void lines.push(message),
    error: () => undefined,
    child: () => impl,
  };
  return { lines, impl };
}

function serviceThatThrows(err: unknown): Pick<WorkspaceService, 'readFileAtRef'> {
  return {
    readFileAtRef: async () => {
      throw err;
    },
  } as unknown as Pick<WorkspaceService, 'readFileAtRef'>;
}

let restore: ILogger | null = null;
afterEach(() => {
  if (restore) setLogger(restore);
  restore = null;
});

describe('readAt', () => {
  /**
   * `readFileAtRef` already answers null for genuine absence, so a null from it
   * is "not on that branch" and says nothing to the operator.
   */
  test('returns null without a word when the file is simply not on the branch', async () => {
    const { lines, impl } = capturing();
    restore = setLogger(impl);
    const service = { readFileAtRef: async () => null } as unknown as Pick<
      WorkspaceService,
      'readFileAtRef'
    >;

    expect(await readAt(service, 'ws', 'agent/weather', 'Plugins/Ops/weather.tool')).toBeNull();
    expect(lines).toEqual([]);
  });

  /**
   * An infra failure still degrades to null — the module's contract is "never
   * throws" — but it must not degrade SILENTLY, or a git timeout reads to the
   * operator exactly like the proposer having withdrawn the file.
   */
  test('warns before degrading to null when the read actually fails', async () => {
    const { lines, impl } = capturing();
    restore = setLogger(impl);

    expect(
      await readAt(serviceThatThrows(new Error('fetch timed out')), 'ws', 'agent/weather', 'Plugins/Ops/weather.tool'),
    ).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Plugins/Ops/weather.tool');
    expect(lines[0]).toContain('fetch timed out');
  });

  /**
   * The path, the branch and the reason are all author-controlled. A raw
   * newline in any of them forges a log line; an escape sequence steers the
   * operator's terminal. Nothing untrusted reaches the sink unescaped.
   */
  test('escapes control characters in the path, the branch and the reason', async () => {
    const { lines, impl } = capturing();
    restore = setLogger(impl);

    await readAt(
      serviceThatThrows(new Error('boom\n[pending-proposals] all clear')),
      'ws',
      'agent/\u001b[31mweather',
      'Plugins/Ops/we\nather.tool',
    );

    const [line] = lines;
    expect(line).toBeDefined();
    // Not one raw newline or escape byte survives into the sink. Spelled as
    // `includes` rather than a character class, because a control character
    // inside a regex literal is itself the thing the linter forbids.
    for (const raw of ['\n', '\r', String.fromCharCode(0x1b)]) {
      expect(line).not.toContain(raw);
    }
    // …and the text is still there to read, just quoted.
    expect(line).toContain('\\n');
    expect(line).toContain('\\u001b');
  });
});
