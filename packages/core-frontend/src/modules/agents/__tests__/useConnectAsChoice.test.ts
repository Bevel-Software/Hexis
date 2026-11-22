import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useConnectAsChoice } from '../useConnectAsChoice';

const BOT = {
  id: 'release-helper',
  name: 'release-helper',
  description: 'Reads; never writes.',
  address: 'release-helper@agent.hexis',
  unavailable: null,
};
const DUPLICATE = { ...BOT, id: 'twin', name: 'twin', address: 'twin@agent.hexis', unavailable: 'two files share the id twin' };

describe('useConnectAsChoice', () => {
  it('starts at Myself and lets nothing connect until the bots answer', () => {
    const { result } = renderHook(() => useConnectAsChoice());
    expect(result.current.value).toBeNull();
    expect(result.current.mayConnect).toBe(false);
    act(() => result.current.settle({ bots: [BOT] }));
    expect(result.current.bots).toEqual([BOT]);
    expect(result.current.mayConnect).toBe(true);
    act(() => result.current.setValue(BOT.id));
    expect(result.current.value).toBe(BOT.id);
  });

  it('drops a remembered choice the answer no longer offers, back to Myself', () => {
    const { result } = renderHook(() => useConnectAsChoice({ initial: 'gone' }));
    expect(result.current.value).toBe('gone');
    act(() => result.current.settle({ bots: [BOT] }));
    expect(result.current.value).toBeNull();
  });

  it('drops a remembered choice of a bot that can no longer be used', () => {
    const { result } = renderHook(() => useConnectAsChoice({ initial: DUPLICATE.id }));
    act(() => result.current.settle({ bots: [BOT, DUPLICATE] }));
    expect(result.current.value).toBeNull();
  });

  it('keeps a remembered choice the answer still offers', () => {
    const { result } = renderHook(() => useConnectAsChoice({ initial: BOT.id }));
    act(() => result.current.settle({ bots: [BOT] }));
    expect(result.current.value).toBe(BOT.id);
  });

  it('waits for Myself to be confirmed when the bots could not be loaded', () => {
    const { result } = renderHook(() => useConnectAsChoice());
    act(() => result.current.settle({ bots: [], failed: true }));
    expect(result.current.unavailable).toBeDefined();
    expect(result.current.mayConnect).toBe(false);
    act(() => result.current.unavailable!.onConfirm(true));
    expect(result.current.mayConnect).toBe(true);
  });

  it('with an expected request, is settled only by that request’s answer', () => {
    const { result, rerender } = renderHook(({ expect: key }) => useConnectAsChoice({ expect: key }), {
      initialProps: { expect: 'state-1' as string | null },
    });
    act(() => result.current.settle({ bots: [] }, 'state-0'));
    expect(result.current.mayConnect).toBe(false);
    act(() => result.current.settle({ bots: [] }, 'state-1'));
    expect(result.current.mayConnect).toBe(true);
    rerender({ expect: 'state-2' });
    expect(result.current.mayConnect).toBe(false);
    rerender({ expect: null });
    expect(result.current.mayConnect).toBe(false);
  });
});
