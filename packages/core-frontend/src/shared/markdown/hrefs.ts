/**
 * How an href is read before anything is decided about it, and which
 * destinations leave the workspace. The definitions live in platform-shared
 * (workspace/kb-hrefs.ts), beside the link grammar that builds on them, so
 * every surface that follows a knowledge-page link reads it one way.
 */
export { isExternalHref, normalizeHref, isOpenableExternalHref, isPageLinkExternalHref } from '@bevel-software/platform-shared';
