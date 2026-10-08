---
'@bevel-software/platform-core-frontend': minor
---

The Get set up list teaches the command menu. A new step for everyone, "Find or do anything with ⌘K" ("Ctrl K" off Apple platforms), says what to type ("a page, a skill, or an action like Invite people") and has a Try it button that opens the menu.

The step ticks once the menu has been opened by any route — the toolbar box, the shortcut or Try it — so someone who already knew the shortcut is never asked to. It is a per-browser note per account, like "read the guide" (`bevel.onboarding.commandMenuOpened.<email>`), and "You're set up" now waits for it too.

New in `modules/toolbar/commands/command-menu`: `openCommandMenu()` opens the menu from anywhere, and `COMMAND_MENU_SHORTCUT_LABEL` is the palette's own platform check for which keys to name. `useSetupChecklist()` gains `openedCommandMenu` and `markCommandMenuOpened()`.
