import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useConnectAsChoice } from '../useConnectAsChoice';

const AGENT = { path: 'Agents/release-helper.agent', name: 'release-helper', description: 'Reads; never writes.' };

describe('useConnectAsChoice', () => {
  it('starts at Everything and lets nothing connect until the agents answer', () => {
    const { result } = renderHook(() => useConnectAsChoice());
    expect(result.current.value).toBeNull();
    expect(result.current.mayConnect).toBe(false);
    act(() => result.current.settle({ agents: [AGENT] }));
    expect(result.current.agents).toEqual([AGENT]);
    expect(result.current.mayConnect).toBe(true);
    act(() => result.current.setValue(AGENT.path));
    expect(result.current.value).toBe(AGENT.path);
  });

  it('drops a remembered choice the answer no longer offers, back to Everything', () => {
    const { result } = renderHook(() => useConnectAsChoice({ initial: 'Agents/gone.agent' }));
    expect(result.current.value).toBe('Agents/gone.agent');
    act(() => result.current.settle({ agents: [AGENT] }));
    expect(result.current.value).toBeNull();
  });

  it('keeps a remembered choice the answer still offers', () => {
    const { result } = renderHook(() => useConnectAsChoice({ initial: AGENT.path }));
    act(() => result.current.settle({ agents: [AGENT] }));
    expect(result.current.value).toBe(AGENT.path);
  });

  it('waits for Everything to be confirmed when the agents could not be loaded', () => {
    const { result } = renderHook(() => useConnectAsChoice());
    act(() => result.current.settle({ agents: [], failed: true }));
    expect(result.current.unavailable).toBeDefined();
    expect(result.current.mayConnect).toBe(false);
    act(() => result.current.unavailable!.onConfirm(true));
    expect(result.current.mayConnect).toBe(true);
  });

  it('with an expected request, is settled only by that request’s answer', () => {
    const { result, rerender } = renderHook(({ expect: key }) => useConnectAsChoice({ expect: key }), {
      initialProps: { expect: 'state-1' as string | null },
    });
    act(() => result.current.settle({ agents: [] }, 'state-0'));
    expect(result.current.mayConnect).toBe(false);
    act(() => result.current.settle({ agents: [] }, 'state-1'));
    expect(result.current.mayConnect).toBe(true);
    // A new request arrives: its own answer is awaited again.
    rerender({ expect: 'state-2' });
    expect(result.current.mayConnect).toBe(false);
    // And without any request there is nothing to connect.
    rerender({ expect: null });
    expect(result.current.mayConnect).toBe(false);
  });
});
