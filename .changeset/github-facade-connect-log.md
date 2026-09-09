---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

The GitHub Enterprise facade says why it refused a step of the connect flow. Claude's servers swallow the answer, so a person who approved on the platform and came back to Claude with no connection had nothing to go on; now every refused authorize, token exchange or API call is a `[github-facade]` line in the server log naming the check that failed, never a secret. Link tokens are spelled the way GitHub spells its own (letters and digits after `gho_`), and the docs and page copy say where the connect step lives: Claude never prompts for it.
