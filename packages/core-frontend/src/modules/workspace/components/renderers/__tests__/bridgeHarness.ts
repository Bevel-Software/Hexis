import vm from 'node:vm';
import { onTestFinished } from 'vitest';
import { buildSandboxedHtml } from '../htmlSandbox';

/**
 * Runs the frame's runtime — the inline module `buildSandboxedHtml` emits, nav
 * bridge included — against a stub document, and records what it does: what
 * it posts to the parent, which element it scrolls into view, whether it
 * scrolled to the top, and whether a click's default was cancelled. Shared by
 * the bridge's own tests and by the drift test that holds the agent guide's
 * `html-views` section to it.
 */
export interface BridgeRun {
  /**
   * Click an `<a>` whose written href is `href`; answers whether the default
   * was cancelled. `alreadyPrevented` is a click a handler of the page's own
   * cancelled before it bubbled up to the bridge. `noAnchor` is a click on
   * something that is not inside an `<a>` at all — a button, a div — which
   * the bridge must leave alone.
   */
  click: (href: string, opts?: { alreadyPrevented?: boolean; noAnchor?: boolean }) => { prevented: boolean };
  /** `window.bevel` as the page's own scripts see it. */
  bevel: Record<string, unknown>;
  /** Messages posted to the parent. */
  posted: unknown[];
  /** Ids (or names) of the elements scrolled into view, in order. */
  scrolled: string[];
  /** The tag of each element scrolled into view, beside `scrolled`: `A`, `INPUT`, `DIV`. */
  scrolledTags: string[];
  /** How many times the page was scrolled to its top. */
  scrolledToTop: () => number;
  /**
   * Deliver a message to the frame's window, as the parent posting it
   * (`fromParent: false` — anything else, such as the page posting to itself).
   * Answers once the frame's handlers and the promises they settle have run.
   */
  deliver: (data: unknown, opts?: { fromParent?: boolean }) => Promise<void>;
  /**
   * Press `key` with focus inside the frame, as it reaches the window.
   * `alreadyPrevented` is one a handler of the page's cancelled before the
   * bridge's; `preventedAfter` one a handler the page added later cancelled
   * after it, in the same dispatch. Answers once the dispatch is over and the
   * task the bridge leaves behind has run.
   */
  press: (key: string, opts?: { alreadyPrevented?: boolean; preventedAfter?: boolean }) => Promise<void>;
}

/**
 * `ids` are elements with that id; `names` are `<a name="…">` anchors;
 * `namedControls` are `<input name="…">` fields, which a fragment must NOT
 * scroll to — the standard's fallback is the named anchor alone.
 */
export function runBridge(
  page: { ids?: string[]; names?: string[]; namedControls?: string[] } = {},
  opts: { toolBridge?: boolean | { documentId: string; tools?: boolean } } = {},
): BridgeRun {
  // No lib sources: a vm script cannot parse an `export`. The bridge is
  // appended after the lib either way.
  const out = buildSandboxedHtml({ title: 't', libModuleSources: [], bodyHtml: '', toolBridge: opts.toolBridge });
  const scriptBody = out.match(/<script type="module">([\s\S]*?)<\/script>/)![1];

  type ClickEvent = { target: { closest: () => unknown }; defaultPrevented: boolean; preventDefault: () => void };
  const handlers: ((e: ClickEvent) => void)[] = [];
  const posted: unknown[] = [];
  const scrolled: string[] = [];
  const scrolledTags: string[] = [];
  let toTop = 0;
  const element = (key: string, tagName = 'DIV') => ({
    tagName,
    scrollIntoView: () => {
      scrolled.push(key);
      scrolledTags.push(tagName);
    },
  });
  const ids = new Set(page.ids ?? []);
  const names = new Set(page.names ?? []);
  const controls = new Set(page.namedControls ?? []);
  const messageHandlers: ((e: { source: unknown; data: unknown }) => void)[] = [];
  const keyHandlers: ((e: { key: string; defaultPrevented: boolean }) => void)[] = [];
  const parent = { postMessage: (msg: unknown) => posted.push(msg) };
  // The frame's request timers, cleared when the test ends: a call a test
  // leaves unanswered must not keep the worker alive for the runtime's
  // fifteen minutes, nor reject long after the test that made it.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  onTestFinished(() => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  });
  const ctx: Record<string, unknown> = {
    // The frame's window: the tool bridge listens on it for the parent's answers.
    addEventListener: (type: string, fn: (e: never) => void) => {
      // One window, two event shapes: the type names which this listener takes.
      if (type === 'message') messageHandlers.push(fn as (e: { source: unknown; data: unknown }) => void);
      if (type === 'keydown') keyHandlers.push(fn as (e: { key: string; defaultPrevented: boolean }) => void);
    },
    setTimeout: (fn: () => void, ms?: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
      return t;
    },
    clearTimeout: (t: ReturnType<typeof setTimeout>) => {
      timers.delete(t);
      clearTimeout(t);
    },
    document: {
      addEventListener: (type: string, fn: (e: ClickEvent) => void) => {
        if (type === 'click') handlers.push(fn);
      },
      getElementById: (id: string) => (ids.has(id) ? element(id) : null),
      // In document order a control comes first here, so a fallback that
      // took "the first named element" would scroll the wrong thing.
      getElementsByName: (name: string) => [
        ...(controls.has(name) ? [element(name, 'INPUT')] : []),
        ...(names.has(name) ? [element(name, 'A')] : []),
      ],
    },
    parent,
    scrollTo: () => {
      toTop += 1;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`"use strict"; (function(){ ${scriptBody} }).call(undefined);`, ctx);
  if (handlers.length !== 1) throw new Error(`the bridge registered ${handlers.length} click listeners`);

  return {
    click: (href: string, opts = {}) => {
      let prevented = opts.alreadyPrevented ?? false;
      const anchor = opts.noAnchor ? null : { getAttribute: () => href };
      handlers[0]({
        target: { closest: () => anchor },
        defaultPrevented: prevented,
        preventDefault: () => (prevented = true),
      });
      return { prevented };
    },
    bevel: ctx.bevel as Record<string, unknown>,
    posted,
    scrolled,
    scrolledTags,
    scrolledToTop: () => toTop,
    deliver: async (data, deliverOpts = {}) => {
      const source = deliverOpts.fromParent === false ? {} : parent;
      for (const fn of messageHandlers) fn({ source, data });
      await new Promise((r) => setTimeout(r, 0));
    },
    press: async (key, pressOpts = {}) => {
      const event = { key, defaultPrevented: pressOpts.alreadyPrevented ?? false };
      for (const fn of keyHandlers) fn(event);
      if (pressOpts.preventedAfter) event.defaultPrevented = true;
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}
