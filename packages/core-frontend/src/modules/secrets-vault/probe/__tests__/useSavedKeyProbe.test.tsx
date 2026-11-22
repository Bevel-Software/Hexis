import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActingForBot } from '../../services/acting-for';
import { useSavedKeyProbe } from '../useSavedKeyProbe';

const checkToolConnection = vi.fn();
vi.mock('../../services/tool-secrets.api', () => ({
  checkToolConnection: (...args: unknown[]) => checkToolConnection(...args),
}));

/**
 * A probe's answer is about one identity's credential. The Connect page keeps
 * its rows mounted when its "Connect as" choice changes, so a verdict about
 * the person's credential must not stay beside the bot's variable, nor the
 * other way round.
 */
describe('useSavedKeyProbe and whose credential it probed', () => {
  it("drops the person's verdict once the page acts for a bot, and brings it back for the person", async () => {
    checkToolConnection.mockResolvedValue({ status: 'ok', checkedAt: '2026-11-22T00:00:00Z' });
    let bot: string | null = null;
    const wrapper = ({ children }: { children: ReactNode }) => createElement(ActingForBot.Provider, { value: bot }, children);
    const { result, rerender } = renderHook(() => useSavedKeyProbe('weather'), { wrapper });

    act(() => result.current.probeSaved('API_KEY'));
    await waitFor(() => expect(result.current.verdict).not.toBeNull());
    expect(checkToolConnection).toHaveBeenLastCalledWith('weather', null);
    expect(result.current.subject).toBe('API_KEY');

    bot = 'ops';
    rerender();
    expect(result.current.verdict).toBeNull();
    expect(result.current.subject).toBeNull();

    bot = null;
    rerender();
    expect(result.current.verdict).not.toBeNull();
  });
});
