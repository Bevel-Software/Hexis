/**
 * Opt-in console diagnostics for the file page (`?trace=files`).
 *
 * Exists to reproduce a report where a file click changes the URL but the page
 * stays on the empty state with no tab strip. `FileRoute` waits on two gates
 * before it opens a file (the git status branch equals the URL branch, and the
 * workspace for that branch bootstrapped), and while either is closed nothing
 * is shown. The trace logs every run of that decision with its inputs, so a
 * browser console tells which gate held the page.
 *
 * The flag is read from the query string once and kept in `sessionStorage`,
 * because a tree click navigates to a clean file URL and would otherwise drop
 * it after the first click. `?trace=off` clears it. Nothing here changes what
 * the page does; with the flag off every call is a no-op.
 */

export const FILE_TRACE_STORAGE_KEY = 'hexis.trace.files';
const PREFIX = '[trace:files]';

// Stands in for `sessionStorage` when it is unavailable (private mode quotas,
// sandboxed frames), so the flag still holds for this page load.
let memoryFlag = false;

/** Reads `?trace=` from `search`, remembering or forgetting the flag for the session. */
export function syncFileTraceFlag(search: string): boolean {
  const value = new URLSearchParams(search).get('trace');
  if (value === 'off') memoryFlag = false;
  try {
    if (value === 'files') sessionStorage.setItem(FILE_TRACE_STORAGE_KEY, '1');
    else if (value === 'off') sessionStorage.removeItem(FILE_TRACE_STORAGE_KEY);
  } catch {
    // Storage unavailable: `memoryFlag` carries it.
    if (value === 'files') memoryFlag = true;
  }
  return isFileTraceEnabled();
}

export function isFileTraceEnabled(): boolean {
  try {
    return sessionStorage.getItem(FILE_TRACE_STORAGE_KEY) === '1' || memoryFlag;
  } catch {
    return memoryFlag;
  }
}

/** Logs one trace event when the flag is on. `fields` is logged as-is. */
export function traceFiles(event: string, fields: Record<string, unknown>): void {
  if (!isFileTraceEnabled()) return;
  console.info(PREFIX, event, { at: Math.round(performance.now()), ...fields });
}
