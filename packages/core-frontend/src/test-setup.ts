import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { configureBranchModel } from '@bevel-software/platform-shared';
// The pure module, NOT the `shared/mcp` barrel: this file runs before every
// test file, and the barrel would drag React components and their icon
// imports into the setup of suites that never touch them.
import { resetMcpUrlForTests } from './shared/mcp/connect-snippets';

// The branch model is applied during boot now, not read from the environment
// at import. In the browser that is `loadServerConfig()`; here it is this,
// pinned to the historical two-branch pair the suites assert against.
configureBranchModel({
  defaultBranch: 'target-company-state',
  protectedBranches: ['current-company-state', 'target-company-state'],
});

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
  /**
   * The MCP endpoint is module-global, the way the branch model is. In the
   * browser it is set once by `loadServerConfig()`; here nothing calls that,
   * so tests start from the origin fallback and any suite that configures a
   * real address cannot leak it into the next one.
   */
  resetMcpUrlForTests();
});

afterEach(() => {
  cleanup();
});
