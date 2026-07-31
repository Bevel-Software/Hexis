import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

function createInMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(String(key), String(value));
    },
  } as Storage;
}

const maybeStorage = globalThis.localStorage as Partial<Storage> | undefined;
if (
  !maybeStorage
  || typeof maybeStorage.clear !== 'function'
  || typeof maybeStorage.getItem !== 'function'
  || typeof maybeStorage.setItem !== 'function'
  || typeof maybeStorage.removeItem !== 'function'
) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: createInMemoryStorage(),
    writable: true,
    configurable: true,
  });
}

// Mirror the storage onto `window` as well so code that reads via `window.localStorage`
// (instead of the bare global) sees the same in-memory shim in tests.
if (typeof window !== 'undefined' && window.localStorage !== globalThis.localStorage) {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: globalThis.localStorage,
  });
}

beforeEach(() => {
  globalThis.localStorage?.clear?.();
});

afterEach(() => {
  cleanup();
});
