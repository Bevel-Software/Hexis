import { createContext, useContext } from 'react';

/**
 * The toast channel, split out from the provider that renders it.
 *
 * Nothing here is a component, and that is the whole point: a module that
 * exports a component AND a plain function can't be hot-swapped, so an edit
 * to the toast markup would full-reload the app instead of Fast Refreshing it
 * (`react-refresh/only-export-components`). Same split as
 * `open-change-requests.context.ts` / `.tsx` and the other `*.context.ts`
 * modules.
 *
 * The provider lives in `./toast.tsx`.
 */

/** Neutral is the default: the message already says what happened. `danger`
 *  exists because half of these are failures, and a failure that renders
 *  identically to a confirmation is worse than no colour at all. */
export type ToastTone = 'neutral' | 'ok' | 'danger';

export type ShowToast = (msg: string, tone?: ToastTone) => void;

/**
 * The default is a no-op rather than a throw (unchanged from when this lived
 * in `toast.tsx`): a toast is advisory feedback, so a consumer rendered
 * outside the provider should drop the message, not crash the tree.
 */
export const ToastContext = createContext<ShowToast>(() => {});

export function useLibraryToast(): ShowToast {
  return useContext(ToastContext);
}
