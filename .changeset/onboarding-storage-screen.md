---
'@bevel-software/platform-core-frontend': minor
---

A fresh deployment asks its admin one question first: where should your knowledge base live?

Until now the first screen was the whole setup form, with the repository the deployment keeps for itself behind a tab among address fields, sign-in settings and folder names. Now an admin whose deployment has chosen no way of having a repository, and is not pinned to one by `GIT_MODE`, sees two cards instead. The recommended one, preselected, has the deployment keep the repository: Continue saves it with nothing to enter. The second, offered when the deployment can connect through a GitHub App, opens the GitHub steps and saves the repository picked there. "Use an address and token" under the cards opens the full form on that tab, so GitLab, Bitbucket, Azure DevOps and single sign-on work as before. After a save the gate opens the knowledge base once setup is complete, where the Get set up list carries the rest; it says when a restart is owed, and otherwise hands over to the full form for whatever is still missing. Every deployment past that first choice sees the full form exactly as before. A distribution names who keeps the repository through the new `managedStorage` registry slot (core says "This server keeps it").
