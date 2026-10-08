---
'@bevel-software/platform-core-frontend': patch
---

Confirmations are the app's own, and "Don't ask again" on branch delete skips the question.

Every question the app asks before an action — deleting a shared branch, closing one or several tabs with unsaved changes, Bevel Recovery, opening a link in an email, replacing a tool file with a scaffold — is now the app's own dialog instead of the browser's built-in `confirm()`. The browser could switch its own dialog off ("prevent this page from creating additional dialogs"), after which every one of those actions quietly did nothing; the app's dialog only answers to the person. The wording is unchanged.

Deleting a shared branch offers "Don't ask again". Ticked, the branch is deleted and that person's later deletions in that browser go ahead without the question, across reloads, until they choose "Ask before deleting branches" in the profile menu. The choice is per person, and a browser that cannot store it asks every time.

For downstream frontends: `useConfirm()` and `ConfirmProvider` are exported from `@bevel-software/platform-core-frontend/ui`; `CoreAppShell` mounts the provider. A lint rule rejects the built-in `confirm`, and the test suite runs it over core-frontend's source.
