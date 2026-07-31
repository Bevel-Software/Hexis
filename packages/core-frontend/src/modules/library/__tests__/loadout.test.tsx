import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LoadoutProvider, useLoadout, LOADOUT_STORAGE_KEY } from '../state/loadout';

const wrapper = ({ children }: { children: ReactNode }) => (
  <LoadoutProvider>{children}</LoadoutProvider>
);

describe('loadout (client-side stub)', () => {
  it('starts empty and adds/removes on toggle', () => {
    const { result } = renderHook(() => useLoadout(), { wrapper });
    expect(result.current.total).toBe(0);

    let added = false;
    act(() => {
      added = result.current.toggle('skill', 'newsletter');
    });
    expect(added).toBe(true);
    expect(result.current.isIn('skill', 'newsletter')).toBe(true);
    expect(result.current.total).toBe(1);

    act(() => {
      result.current.toggle('integration', 'slack');
    });
    expect(result.current.total).toBe(2);
    expect(result.current.integrations).toEqual(['slack']);

    act(() => {
      added = result.current.toggle('skill', 'newsletter');
    });
    expect(added).toBe(false);
    expect(result.current.isIn('skill', 'newsletter')).toBe(false);
    expect(result.current.total).toBe(1);
  });

  it('remove drops only the targeted item', () => {
    const { result } = renderHook(() => useLoadout(), { wrapper });
    act(() => {
      result.current.toggle('skill', 'a');
      result.current.toggle('skill', 'b');
    });
    act(() => {
      result.current.remove('skill', 'a');
    });
    expect(result.current.skills).toEqual(['b']);
  });

  it('persists to localStorage under bevel-library-loadout-v1 and survives a remount', () => {
    const first = renderHook(() => useLoadout(), { wrapper });
    act(() => {
      first.result.current.toggle('skill', 'rfi');
      first.result.current.toggle('integration', 'github');
    });
    const raw = localStorage.getItem(LOADOUT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ skills: ['rfi'], integrations: ['github'] });
    first.unmount();

    // A fresh provider (new session) reads the persisted loadout back.
    const second = renderHook(() => useLoadout(), { wrapper });
    expect(second.result.current.isIn('skill', 'rfi')).toBe(true);
    expect(second.result.current.isIn('integration', 'github')).toBe(true);
    expect(second.result.current.total).toBe(2);
  });

  it('tolerates corrupted stored state', () => {
    localStorage.setItem(LOADOUT_STORAGE_KEY, '{not json');
    const { result } = renderHook(() => useLoadout(), { wrapper });
    expect(result.current.total).toBe(0);
  });
});
