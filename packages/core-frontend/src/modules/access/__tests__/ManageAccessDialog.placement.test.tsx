import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';

// --- Mock the API module ----------------------------------------------------
const api = vi.hoisted(() => ({
  fetchFileAccess: vi.fn(),
  grantAccess: vi.fn(),
  revokeAccess: vi.fn(),
  suggestPrincipals: vi.fn(),
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, ...api };
});

// --- Mock the context hooks the dialog reads --------------------------------
vi.mock('../../workspace/state/workspace.context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', kbDirName: 'knowledge-base' }),
}));
vi.mock('../../auth/state/auth.context', () => ({
  useAuth: () => ({ user: { email: 'me@x.com', name: 'Me' } }),
}));

import { ManageAccessDialog } from '../components/ManageAccessDialog';

const KB = 'knowledge-base';
const ENTRY: FileTreeEntry = {
  name: 'Deal.md',
  relativePath: `${KB}/Sales/Deal.md`,
  type: 'file',
} as unknown as FileTreeEntry;
const A = { name: 'Alice', email: 'alice@x.com' };

/** Alice, granted read + write directly here — one row with an editable checklist. */
const VIEW = {
  canRead: true,
  canWrite: true,
  canDownload: false,
  canOwner: false,
  eligible: { roles: [], users: [A] },
  readers: { restricted: true, roles: [], users: [A] },
  owners: { roles: [], users: [] },
  downloaders: { roles: [], users: [] },
  sources: { 'u:alice@x.com': { read: [{ kind: 'direct' }], write: [{ kind: 'direct' }] } },
} as AccessResponse;

// The viewport the placement math is measured against. Pinned so the expected
// coordinates below are arithmetic, not whatever happy-dom defaults to.
const VIEWPORT = { width: 1200, height: 800 };
/** `MENU_MIN_WIDTH` — the width every menu here is clamped up to. */
const MENU_W = 200;

/**
 * happy-dom runs no layout engine: every rect is 0×0 at the origin and
 * `offsetHeight` is always 0, so `AnchoredMenu` would be measuring a
 * degenerate viewport in which nothing ever overflows and nothing ever flips.
 * These hand the component the two boxes it measures — the trigger's parent
 * and the panel — with numbers the test controls.
 */
const rects = new Map<Element, DOMRect>();
const NO_RECT = {
  top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
  toJSON: () => ({}),
} as DOMRect;

function setRect(el: Element, r: { top: number; left: number; width: number; height: number }) {
  rects.set(el, {
    ...r,
    right: r.left + r.width,
    bottom: r.top + r.height,
    x: r.left,
    y: r.top,
    toJSON: () => r,
  } as DOMRect);
}

/**
 * The open panel's height. Only `AnchoredMenu`'s own wrapper is `fixed` AND
 * measured — `Dialog`'s scrim is fixed too but nothing reads its height — so
 * keying the stub on the class is unambiguous here.
 */
let menuHeight = 0;

/**
 * A `ResizeObserver` the test can fire by hand. The real one never delivers in
 * happy-dom (it has no layout to observe), and the whole point of these cases
 * is what happens when a box the menu is anchored to changes size.
 */
interface Watcher {
  cb: () => void;
  targets: Set<Element>;
}
let watchers: Watcher[] = [];

class TestResizeObserver {
  private readonly watcher: Watcher;
  constructor(cb: () => void) {
    this.watcher = { cb, targets: new Set() };
    watchers.push(this.watcher);
  }
  observe(el: Element) {
    this.watcher.targets.add(el);
  }
  unobserve(el: Element) {
    this.watcher.targets.delete(el);
  }
  disconnect() {
    this.watcher.targets.clear();
  }
}

/** Deliver a resize notification for `el` to every observer watching it. */
function resize(el: Element) {
  act(() => {
    for (const w of watchers) if (w.targets.has(el)) w.cb();
  });
}

let offsetHeightDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchFileAccess.mockResolvedValue(VIEW);
  api.suggestPrincipals.mockResolvedValue({ plugins: [], people: [], peopleWithheld: false });

  rects.clear();
  watchers = [];
  menuHeight = 0;

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return rects.get(this) ?? NO_RECT;
  });
  offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('fixed') ? menuHeight : 0;
    },
  });
  for (const [k, v] of Object.entries(VIEWPORT)) {
    Object.defineProperty(window, k === 'width' ? 'innerWidth' : 'innerHeight', {
      configurable: true,
      writable: true,
      value: v,
    });
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (offsetHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDescriptor);
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  }
});

/**
 * Open Alice's verb menu with her row's trigger sitting at `anchor`, and hand
 * back both the trigger's anchor box and the open panel.
 *
 * The add-row's verb selector reads "Can edit" too; Alice's row trigger is the
 * later one in the DOM. The rect has to be registered BEFORE the click — the
 * placement runs in a layout effect on the render that opens the menu.
 */
async function openAliceMenu(
  user: ReturnType<typeof userEvent.setup>,
  anchor: { top: number; left: number; width: number; height: number },
) {
  const triggers = await screen.findAllByRole('button', { name: /^can edit$/i });
  const trigger = triggers[triggers.length - 1];
  const anchorEl = trigger.parentElement!;
  setRect(anchorEl, anchor);

  await user.click(trigger);

  const panel = screen
    .getByRole('button', { name: /remove access/i })
    .closest('div.fixed') as HTMLElement;
  return { anchorEl, panel };
}

/**
 * WHERE AN OPEN MENU IS PLACED.
 *
 * `Dialog` renders its body inside `overflow-y-auto`, which clips an
 * absolutely positioned menu: opening the verb menu on a low grantee row cut
 * everything past the first item or two — "Remove access" included — off at
 * the body's edge, unreachable without scrolling the list out from under the
 * menu. The menus are `fixed` now, which means the placement is computed
 * rather than inherited, and has to keep up with everything that moves it.
 */
describe('ManageAccessDialog: where an open menu is placed', () => {
  it('escapes the dialog body by going fixed, at coordinates measured off the trigger', async () => {
    const user = userEvent.setup();
    menuHeight = 150;
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    // A trigger low in a scrolled list — the case that used to be clipped.
    const { panel } = await openAliceMenu(user, { top: 600, left: 700, width: 120, height: 28 });

    expect(panel).toHaveClass('fixed');
    // Right edge lines up with the trigger's: 820 - 200.
    expect(panel.style.left).toBe('620px');
    // Below the trigger, MENU_GAP under its bottom edge: 628 + 4.
    expect(panel.style.top).toBe('632px');
    expect(panel.style.width).toBe(`${MENU_W}px`);
    // NOT portaled: the panel stays inside the dialog, whose focus trap only
    // queries its own subtree, so the items remain Tab-reachable.
    expect(screen.getByRole('dialog').contains(panel)).toBe(true);
  });

  it('flips above the trigger when the panel would run off the bottom', async () => {
    const user = userEvent.setup();
    menuHeight = 200; // 632 + 200 overruns the 800px viewport
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const { panel } = await openAliceMenu(user, { top: 600, left: 700, width: 120, height: 28 });

    // Above: trigger top - MENU_GAP - height = 600 - 4 - 200.
    expect(panel.style.top).toBe('396px');
  });

  it('re-anchors when the trigger relabels itself and changes width', async () => {
    const user = userEvent.setup();
    menuHeight = 150;
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const { anchorEl, panel } = await openAliceMenu(user, {
      top: 600, left: 700, width: 120, height: 28,
    });
    expect(panel.style.left).toBe('620px');

    // The trigger's label IS `summarizeVerbs(...)`, so ticking a box in the
    // open menu rewrites it ("Can edit" → "Owner, Can download") and the box
    // grows. No scroll, no window resize — nothing else tells the menu.
    setRect(anchorEl, { top: 600, left: 700, width: 180, height: 28 });
    resize(anchorEl);

    // Still flush with the trigger's right edge: 880 - 200.
    expect(panel.style.left).toBe('680px');
  });

  it('re-flips when the panel itself grows past the room below', async () => {
    const user = userEvent.setup();
    menuHeight = 150;
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const { panel } = await openAliceMenu(user, { top: 600, left: 700, width: 120, height: 28 });
    expect(panel.style.top).toBe('632px');

    // The panel's own height follows its contents — the autocomplete's list
    // grows and shrinks with every keystroke — so a menu measured to fit below
    // stops fitting while it is open.
    menuHeight = 200;
    resize(panel);

    expect(panel.style.top).toBe('396px');
  });

  it('keeps the panel inside the viewport when the trigger is at the right edge', async () => {
    const user = userEvent.setup();
    menuHeight = 150;
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    // A trigger whose right edge is past the viewport's — the dialog is wider
    // than the window, or the window shrank under it.
    const { panel } = await openAliceMenu(user, { top: 100, left: 1170, width: 40, height: 28 });

    // Flush with the trigger would be 1210 - 200 = 1010, off the right edge.
    // Pulled in to leave MENU_MARGIN: 1200 - 200 - 8.
    expect(panel.style.left).toBe('992px');
  });
});
