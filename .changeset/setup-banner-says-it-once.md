---
'@bevel-software/platform-core-frontend': patch
---

A tool page's "Your connection" section no longer opens with a banner summarising what the tool is missing. The banner said "this tool needs 2 things before it works", then listed each missing variable as "Label: status" — directly above rows carrying those same labels, those same statuses and the buttons that fix them, including a Set key that opened the very row editor the row's own Set key opens. The reader met the same sentence twice, with two identical buttons.

What the banner really contributed was colour, so colour is what survived it. A variable that is required and has no value now renders its own row on the amber `wait` ground, keeping its Set key or Add key button; a row with a value keeps the normal tone. The count the banner stated in prose is now the number of amber rows, which cannot drift out of step with them the way a separately computed sentence could.

A pending sign-in on a fully configured provider stays in the normal tone, as it stayed out of the banner: nothing about that tool is unconfigured, and signing in is a step each person takes rather than a gap in its setup. Screen readers get in words what the amber says in colour — an unset row announces "Required, not set" before its button.

Two banners are unchanged, because each names something no row can see: the sign-in setup banner, for an `oauth-manual` server whose owner has not registered the OAuth app yet, and the rejected-credential banner, which only a real call to the provider could have earned.
