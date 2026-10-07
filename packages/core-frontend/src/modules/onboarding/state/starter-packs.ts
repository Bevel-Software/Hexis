import { useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import { AuthContext } from '../../auth/state/auth.context';
import {
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
    .finally(() => inFlight.delete(userId));
  inFlight.set(userId, request);
  return request;
}

/** Test seam: forget every answer. */
export function resetStarterPacksForTests(): void {
  answers.clear();
  inFlight.clear();
  version++;
  listeners.forEach((l) => l());
}

export interface StarterPacksState {
  /** The server's answer; null until it arrives, or when it could not be had. */
  answer: StarterPacksAnswer | null;
  /** The first request has come back, either way. */
  settled: boolean;
  /** Ask again — after the tree changed under a chosen pack's pages, say. */
  reload(): Promise<void>;
  /** Answer the question (a pack's id, or `none`); resolves to what was added, and the answer is re-read. */
  choose(id: string): Promise<StarterPackApplied>;
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
    if (userId) await load(userId);
  }, [userId]);

  const choose = useCallback(
    async (id: string) => {
      const applied = await chooseStarterPack(id);
      if (userId) {
        // The question is answered whatever the re-read says: never show it
        // again on the strength of a request that failed.
        const before = answers.get(userId);
        if (before) remember(userId, { ...before, offered: false, chosen: id });
        await load(userId);
      }
      return applied;
    },
    [userId],
  );

  return {
    answer: userId ? (answers.get(userId) ?? null) : null,
    settled: !!userId && answers.has(userId),
    reload,
    choose,
  };
}
