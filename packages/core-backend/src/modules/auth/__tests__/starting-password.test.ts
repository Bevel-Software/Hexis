import { describe, expect, it, vi } from 'vitest';

// The source is the operating system's cryptographic one: the generator's
// only randomness is `crypto.randomInt`, observed here, not Math.random.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

const { randomInt } = await import('node:crypto');
const { generateStartingPassword } = await import('../starting-password.js');

describe('generateStartingPassword', () => {
  it('is at least 16 letters and digits, without 0, O, 1, l or I', () => {
    for (let i = 0; i < 200; i++) {
      const password = generateStartingPassword();
      expect(password.length).toBeGreaterThanOrEqual(16);
      expect(password).toMatch(/^[A-Za-z2-9]+$/);
      expect(password).not.toMatch(/[0O1lI]/);
    }
  });

  it('draws every symbol from crypto.randomInt and never from Math.random', () => {
    const mathRandom = vi.spyOn(Math, 'random');
    vi.mocked(randomInt).mockClear();
    const password = generateStartingPassword();
    expect(vi.mocked(randomInt)).toHaveBeenCalledTimes(password.length);
    expect(mathRandom).not.toHaveBeenCalled();
    mathRandom.mockRestore();
  });

  it('is a different password each time', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateStartingPassword()));
    expect(seen.size).toBe(1000);
  });
});
