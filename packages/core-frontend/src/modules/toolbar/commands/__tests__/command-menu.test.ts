import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * How a command's shortcut is drawn, per platform. The platform is read once,
 * when the module loads, so each case loads it afresh under its own user
 * agent.
 */
async function loadOn(userAgent: string) {
  vi.resetModules();
  vi.stubGlobal('navigator', { ...navigator, userAgent });
  return import('../command-menu');
}

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shortcutHint', () => {
  it('draws a Shift key as ⇧ and the capital on Apple devices', async () => {
    const { shortcutHint, shortcutKeycapWidth, COMMAND_MENU_SHORTCUT_LABEL } = await loadOn(MAC);
    expect(COMMAND_MENU_SHORTCUT_LABEL).toBe('⌘K');
    expect(shortcutHint({ key: 'c' })).toEqual({ label: 'C', spoken: 'C', aria: 'C' });
    expect(shortcutHint({ key: 'i', shift: true })).toEqual({ label: '⇧I', spoken: 'Shift I', aria: 'Shift+I' });
    expect(shortcutHint({ key: 'k', shift: true }).label).toBe('⇧K');
    expect(shortcutHint({ key: 's', shift: true }).label).toBe('⇧S');
    expect(shortcutKeycapWidth()).toBe('w-7');
  });

  it('draws it as "Shift" and the letter elsewhere', async () => {
    const { shortcutHint, shortcutKeycapWidth, COMMAND_MENU_SHORTCUT_LABEL } = await loadOn(WINDOWS);
    expect(COMMAND_MENU_SHORTCUT_LABEL).toBe('Ctrl K');
    expect(shortcutHint({ key: 'c' })).toEqual({ label: 'C', spoken: 'C', aria: 'C' });
    expect(shortcutHint({ key: 'i', shift: true })).toEqual({ label: 'Shift I', spoken: 'Shift I', aria: 'Shift+I' });
    expect(shortcutHint({ key: 'k', shift: true }).label).toBe('Shift K');
    expect(shortcutHint({ key: 's', shift: true }).label).toBe('Shift S');
    expect(shortcutKeycapWidth()).toBe('w-14');
  });

  it('gives every keycap on a platform one width, whatever its key', async () => {
    const { shortcutHint, shortcutKeycapWidth } = await loadOn(MAC);
    // One width for the platform, not one per key: C sits in the same cap as ⇧K.
    expect(shortcutHint({ key: 'c' }).label).toBe('C');
    expect(shortcutKeycapWidth()).toBe(shortcutKeycapWidth(true));
    expect(shortcutKeycapWidth(false)).toBe('w-14');
  });
});
