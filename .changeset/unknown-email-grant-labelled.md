---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

A grant to an email with no account now says so, and stays allowed. Typing an address the deployment has never seen turns into a chip like any other, and the tester who tried it expected a refusal — but under single sign-on an account exists only after the first sign-in, so granting ahead of time is the normal way to invite someone. Refusing it would break exactly the case it looks like a mistake in.

What was missing was the sentence, not the rule. Every person in the resolved access view and in the share dialog's suggestions now carries `hasAccount`, read from the users table each time the view is built, and the dialog renders it as a quiet "hasn't signed in yet" beside the chip while the grant is being composed and beside the name once it is saved. A typo is visible where it is made, the grant is written verbatim either way, and the note disappears on its own the first time that person signs in — nobody edits the grant to clear it.

Nothing gates on the flag. The grant, revoke and deny routes are untouched, and an agent editing `access.md` or a node's frontmatter directly never sees it. A server that omits the field (version skew) labels nobody, because silence is not the same as "no account".
