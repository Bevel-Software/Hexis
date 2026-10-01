---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

Changing the knowledge-base repository now takes effect on the save, and says what it costs first. Saving an address that names a different repository is refused until the admin confirms that every working copy on this server stops being used and is cloned fresh — anything committed there and never pushed goes out of the app with it, recoverable only from the `replaced-working-copies` folder on the server — and, when change requests are open, chooses whether to keep them (the repository only moved) or close them as "repository replaced", which also releases the file locks held on their branches and takes any commit still queued for them off the worker and onto the admin surface. Nothing is deleted from the database either way, and a close that cannot be done refuses the whole save rather than changing the address with those requests left open. The confirmed save runs the knowledge-base startup phase, so the app opens on the new repository's content without a restart. An address that differs only in spelling is the same repository and changes nothing.

A boot no longer stops on what the host answered about the repository or the credentials — "repository not found", a rejected token, a refused write — wherever in the phase it was raised: the deployment comes up gated, the setup screen shows the cause in plain words, and saving retries. Every other failure still stops the boot. A refused save now shows the reason the host gave, not only that it did not save.
