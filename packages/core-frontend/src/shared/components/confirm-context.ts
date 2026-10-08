import { createContext, useContext, type ReactNode } from 'react';

/**
 * What the app asks before an action, through its own dialog — never the
 * browser's `window.confirm`.
 *
 * The built-in dialog can be switched off by the browser itself: after a few
 * of them it offers "prevent this page from creating additional dialogs", and
 * from then on every `confirm()` answers false without showing anything. The
 * page cannot tell that apart from a real Cancel, so the action it guarded
 * just stopped, without a word. The app's own dialog has no such switch:
 * only the person's Confirm, Cancel, Escape or close answers it.
 */
export interface ConfirmRequest {
  /** The dialog's header. */
  title: ReactNode;
  /** The question. A string keeps its line breaks. */
  message: ReactNode;
  /** The confirming button's label. Defaults to "OK". */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Paint the confirming button in the danger tone. */
  destructive?: boolean;
  /**
   * Offer a "Don't ask again" box. The dialog only REPORTS the tick; the
   * caller decides what remembering it means, and where it is stored.
   */
  offerDontAskAgain?: boolean;
}

export interface ConfirmAnswer {
  confirmed: boolean;
  /** The "Don't ask again" box was ticked when the person confirmed. */
  dontAskAgain: boolean;
}

export type ConfirmFn = (request: ConfirmRequest) => Promise<ConfirmAnswer>;

export const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Without a `ConfirmProvider` there is nobody to ask, and an answer made up
 * here would be exactly the silent "no" this replaces — so it fails loudly.
 */
const missingProvider: ConfirmFn = () =>
  Promise.reject(new Error('useConfirm() needs a <ConfirmProvider> above it'));

/**
 * Ask the person, and wait for the answer. The returned function is stable,
 * so it can sit in a hook's dependency list.
 *
 *   const confirm = useConfirm();
 *   const { confirmed } = await confirm({ title: 'Delete', message: '…' });
 */
export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext) ?? missingProvider;
}
