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
 * pack that was chosen). One request per account per page load, and a choice
 * made in one is seen by the other at once, without asking the server twice.
 *
 * Kept per account, so a tab that switches accounts never shows one person's
 * answer to the next. A failed request is remembered as nothing known: the
 * card stays away and the generic prompt stands, which is what the app did
 * before there were packs.
 */

const answers = new Map<string, StarterPacksAnswer | null>();
const inFlight = new Map<string, Promise<void>>();
/** Accounts asked for again while their request was out: one more request follows it. */
const again = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => version;

function remember(userId: string, answer: StarterPacksAnswer | null): void {
  answers.set(userId, answer);
  version++;
  listeners.forEach((l) => l());
}

/** The answer for `userId`, requested once: concurrent first reads (the viewer's and the column's) share one request. */
function load(userId: string): Promise<void> {
  const running = inFlight.get(userId);
  if (running) return running;
  const request = fetchStarterPacks()
    .then(
      (answer) => remember(userId, answer),
      () => {
        if (!answers.has(userId)) remember(userId, null);
      },
    )
    .finally(() => {
      inFlight.delete(userId);
      if (again.delete(userId)) void load(userId);
    });
  inFlight.set(userId, request);
  return request;
}

/**
 * Ask again, because something changed (a page filled in, a choice made):
 * a request already out may have been answered before the change, so one
 * more follows it, and whoever asked waits for the one that saw the change.
 */
function refresh(userId: string): Promise<void> {
  const running = inFlight.get(userId);
  if (!running) return load(userId);
  again.add(userId);
  return running.then(() => inFlight.get(userId) ?? Promise.resolve());
}

/** Test seam: forget every answer. */
export function resetStarterPacksForTests(): void {
  answers.clear();
  inFlight.clear();
  again.clear();
  version++;
  listeners.forEach((l) => l());
}

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
  const userId = auth?.user?.id ?? null;
  useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (!enabled || !userId || answers.has(userId)) return;
    void load(userId);
  }, [enabled, userId]);

  const reload = useCallback(async () => {
    if (userId) await refresh(userId);
  }, [userId]);

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
        if (err instanceof StarterPackApiError && err.status === 409 && userId) await refresh(userId);
        throw err;
      }
      if (settle) await settle(applied).catch(() => null);
      if (userId) {
        // The question is answered whatever the re-read says: never show it
        // again on the strength of a request that failed.
        const before = answers.get(userId);
        if (before) remember(userId, { ...before, offered: false, chosen: id });
        await refresh(userId);
      }
      return applied;
    },
    [userId],
  );

  return {
    answer: userId ? (answers.get(userId) ?? null) : null,
    settled: !userId || answers.has(userId),
    reload,
    choose,
  };
}
