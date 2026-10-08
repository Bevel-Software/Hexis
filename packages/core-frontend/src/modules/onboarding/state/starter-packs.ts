import { useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import { AuthContext } from '../../auth/state/auth.context';
import {
  StarterPackApiError,
  chooseStarterPack,
  fetchStarterPacks,
  type StarterPackApplied,
  type StarterPacksAnswer,
} from '../services/starter-packs.api';

/**
 * The starter-pack answer, shared by the two places that read it: the
 * knowledge base's empty state (which asks "What does your team do?" while it
 * is offered) and the Get set up list (whose first-page prompt follows the
 * pack that was chosen). One request per signed-in user per page load, and a
 * choice made in one is seen by the other at once, without asking the server
 * twice.
 *
 * Kept PER SIGNED-IN USER — the store hangs off the auth context's user
 * object, which the session holds for as long as that person is signed in
 * — so a tab that switches accounts never shows one person's answer to the
 * next, and a fresh session starts from nothing. A failed request is
 * remembered as nothing known: the card stays away and the generic prompt
 * stands, which is what the app did before there were packs.
 */

interface Store {
  answer: StarterPacksAnswer | null;
  /** The first request has come back, either way. */
  settled: boolean;
  inFlight: Promise<void> | null;
  /** Asked for again while a request was out: one more request follows it. */
  again: boolean;
  version: number;
  listeners: Set<() => void>;
  subscribe(listener: () => void): () => void;
  snapshot(): number;
}

const stores = new WeakMap<object, Store>();

function storeFor(user: object): Store {
  const found = stores.get(user);
  if (found) return found;
  const store: Store = {
    answer: null,
    settled: false,
    inFlight: null,
    again: false,
    version: 0,
    listeners: new Set(),
    subscribe(listener) {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    snapshot: () => store.version,
  };
  stores.set(user, store);
  return store;
}

function remember(store: Store, answer: StarterPacksAnswer | null): void {
  store.answer = answer;
  store.settled = true;
  store.version++;
  store.listeners.forEach((l) => l());
}

/** The answer, requested once: concurrent first reads (the viewer's and the column's) share one request. */
function load(store: Store): Promise<void> {
  if (store.inFlight) return store.inFlight;
  const request = fetchStarterPacks()
    .then(
      (answer) => remember(store, answer),
      () => {
        if (!store.settled) remember(store, null);
      },
    )
    .finally(() => {
      store.inFlight = null;
      if (store.again) {
        store.again = false;
        void load(store);
      }
    });
  store.inFlight = request;
  return request;
}

/**
 * Ask again, because something changed (a page filled in, a choice made):
 * a request already out may have been answered before the change, so one
 * more follows it, and whoever asked waits for the one that saw the change.
 */
function refresh(store: Store): Promise<void> {
  if (!store.inFlight) return load(store);
  store.again = true;
  return store.inFlight.then(() => store.inFlight ?? Promise.resolve());
}

const nobody = {
  subscribe: () => () => {},
  snapshot: () => 0,
};

export interface StarterPacksState {
  /** The server's answer; null until it arrives, or when it could not be had. */
  answer: StarterPacksAnswer | null;
  /** The first request has come back, either way — or there is no account to ask for. */
  settled: boolean;
  /** Ask again — after the tree changed under a chosen pack's pages, say. */
  reload(): Promise<void>;
  /**
   * Answer the question (a pack's id, or `none`); resolves to what was added,
   * and the answer is re-read. `settle` runs after the server answered and
   * BEFORE the shared answer changes under its readers: for what must be in
   * place by then (the tree, with the pack's pages in it). Its failure is
   * not the choice's.
   */
  choose(id: string, settle?: (applied: StarterPackApplied) => Promise<unknown>): Promise<StarterPackApplied>;
}

export function useStarterPacks({ enabled = true }: { enabled?: boolean } = {}): StarterPacksState {
  const auth = useContext(AuthContext);
  const user = auth?.user ?? null;
  const store = user ? storeFor(user) : null;
  useSyncExternalStore(store?.subscribe ?? nobody.subscribe, store?.snapshot ?? nobody.snapshot, nobody.snapshot);

  useEffect(() => {
    if (!enabled || !store || store.settled) return;
    void load(store);
  }, [enabled, store]);

  const reload = useCallback(async () => {
    if (store) await refresh(store);
  }, [store]);

  const choose = useCallback(
    async (id: string, settle?: (applied: StarterPackApplied) => Promise<unknown>) => {
      let applied: StarterPackApplied;
      try {
        applied = await chooseStarterPack(id);
      } catch (err) {
        // Refused because the question is no longer asked — answered in
        // another tab, say: the answer is read again, so the card goes. A
        // lock refusal wears the same status; its re-read finds the offer
        // still standing, and the card stays to say so.
        if (err instanceof StarterPackApiError && err.status === 409 && store) await refresh(store);
        throw err;
      }
      if (settle) await settle(applied).catch(() => null);
      if (store) {
        // The question is answered whatever the re-read says: never show it
        // again on the strength of a request that failed.
        if (store.answer) remember(store, { ...store.answer, offered: false, chosen: id });
        await refresh(store);
      }
      return applied;
    },
    [store],
  );

  return {
    answer: store?.answer ?? null,
    settled: !store || store.settled,
    reload,
    choose,
  };
}
