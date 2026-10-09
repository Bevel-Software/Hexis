import vm from 'node:vm';
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
}

/**
 * `ids` are elements with that id; `names` are `<a name="…">` anchors;
 * `namedControls` are `<input name="…">` fields, which a fragment must NOT
 * scroll to — the standard's fallback is the named anchor alone.
 */
export function runBridge(page: { ids?: string[]; names?: string[]; namedControls?: string[] } = {}): BridgeRun {
  // No lib sources: a vm script cannot parse an `export`. The bridge is
  // appended after the lib either way.
  const out = buildSandboxedHtml({ title: 't', libModuleSources: [], bodyHtml: '' });
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
  const ctx: Record<string, unknown> = {
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
    parent: { postMessage: (msg: unknown) => posted.push(msg) },
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
  };
}
