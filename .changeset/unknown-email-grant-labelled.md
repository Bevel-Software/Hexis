---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

A grant to an email with no account now says so, and stays allowed. Typing an address the deployment has never seen turns into a chip like any other, and the tester who tried it expected a refusal — but under single sign-on an account exists only after the first sign-in, so granting ahead of time is the normal way to invite someone. Refusing it would break exactly the case it looks like a mistake in.

What was missing was the sentence, not the rule. Every person in the resolved access view and in the share dialog's suggestions now carries `hasAccount`, read from the users table each time the view is built, and the dialog renders it as a quiet "hasn't signed in yet" beside the chip while the grant is being composed and beside the name once it is saved. A typo is visible where it is made, the grant is written verbatim either way, and the note disappears on its own the first time that person signs in — nobody edits the grant to clear it.

Nothing gates on the flag. The grant, revoke and deny routes are untouched, and an agent editing `access.md` or a node's frontmatter directly never sees it. A server that omits the field (version skew) labels nobody, because silence is not the same as "no account".

The note is only ever shown on evidence. A chip is labelled when the server said `hasAccount: false` about that exact address, or when it answered a lookup of it and did not name it — and the suggest answer now says outright (`accountsKnown`) that it speaks about accounts, so an older build and an autocomplete outage both leave the address unjudged rather than accusing every free-typed email. The suggestion list sorts an exact email match to the front so the fifteen-person cap can never hide it, a later answer that says an account is gone takes the earlier claim back, and the users lookup behind the flag is best-effort: it is read after the mutation has already committed, so a lookup that fails omits the field instead of turning a saved grant into a 500.
