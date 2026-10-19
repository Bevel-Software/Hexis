import { describe, expect, it, vi } from 'vitest';
import { ChangeRequestHooks, type ChangeRequestOpenedEvent } from '../change-request-hooks.js';

const EVENT: ChangeRequestOpenedEvent = {
  number: 12,
  title: 'Tidy the glossary',
  sourceBranch: 'ali/x',
  targetBranch: 'main',
  openedBy: { id: 'u-ali', email: 'ali@acme.test', name: 'Ali' },
  approvers: [{ id: 'u-dana', email: 'dana@acme.test', name: 'Dana' }],
  unresolvedApprovers: 0,
};

describe('ChangeRequestHooks: a change request was opened', () => {
  it('notifies nobody when nothing is registered, and says so', async () => {
    expect(await new ChangeRequestHooks().runChangeRequestOpened(EVENT)).toEqual([]);
  });

  it('runs every listener in registration order, with the event, and collects the channels that reached the approvers', async () => {
    const hooks = new ChangeRequestHooks();
    const seen: string[] = [];
    hooks.onChangeRequestOpened(async (event) => {
      seen.push(`mail:#${event.number}:${event.approvers.map((a) => a.email).join(',')}`);
      return 'email';
    });
    hooks.onChangeRequestOpened(async () => {
      seen.push('chat');
      return null;
    });
    hooks.onChangeRequestOpened(async () => {
      seen.push('sms');
      return 'sms';
    });
    expect(await hooks.runChangeRequestOpened(EVENT)).toEqual(['email', 'sms']);
    expect(seen).toEqual(['mail:#12:dana@acme.test', 'chat', 'sms']);
  });

  it('a listener that throws counts as not having notified, and stops nothing', async () => {
    const hooks = new ChangeRequestHooks();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      hooks.onChangeRequestOpened(async () => {
        throw new Error('smtp down');
      });
      hooks.onChangeRequestOpened(async () => 'email');
      expect(await hooks.runChangeRequestOpened(EVENT)).toEqual(['email']);
      // Logged, so a failing mailer is diagnosable from the server's log.
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]![0])).toContain('a change-request-opened listener failed');
    } finally {
      error.mockRestore();
    }
  });

  it('an empty channel name is no channel: it counts as not having notified', async () => {
    const hooks = new ChangeRequestHooks();
    hooks.onChangeRequestOpened(async () => '');
    hooks.onChangeRequestOpened(async () => 'email');
    expect(await hooks.runChangeRequestOpened(EVENT)).toEqual(['email']);
  });
});
