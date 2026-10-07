---
'@bevel-software/platform-core-backend': patch
---

An agent is told that a personal plugin holds only its owner's skills and tools, and that knowledge goes under the knowledge root whether or not it is private.

- `my_plugin`'s description now opens with the rule: this is the caller's **personal plugin**, their own skills and tools; notes, knowledge and other documents go under the deployment's knowledge folder instead; and when the user wants something kept private, the agent asks where under that folder it should go, says a folder there can be restricted so only they can read it, and does not write it into the personal plugin even if asked. The `skillsDir` mechanics follow, so a client that cuts a description near 500 characters keeps the rule and loses only detail the guide states in full. The description names the knowledge folder as this deployment spells it, and follows a rename applied by first-run setup without a restart.
- The agent guide says the same in **Where a new file goes**, including the insist case: decline, explain that a document in a personal plugin sits outside the knowledge graph where it is never found as knowledge, and offer the knowledge root again. A skill's own bundled files stay welcome inside that skill's folder.
- Every agent-facing mention of the folder — in `my_plugin`, the guide's directory structure, its placement rules and its `everyone` note — now calls it the "personal plugin", the name the app shows. "Personal space", "private space" and "own space" are gone from the guide.

Guidance only. Writing any file into a personal plugin succeeds exactly as before, no write is refused by this change, and `my_plugin` keeps its endpoint, inputs, outputs, tags and returned folder.
