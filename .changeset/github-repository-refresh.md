---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

On the GitHub tab of the setup screen, the list of repositories can be brought up to date, and changing what the app reaches no longer takes the setup screen away.

Once the app is installed, the address that installs it opens the installation's settings on GitHub, and GitHub sends nobody back from that page. So "Connect GitHub again" left the admin on GitHub with no way back, and a repository added there was never offered.

- **Change repositories on GitHub** opens those settings in another tab.
- **Refresh the list** reads again which repositories may be connected, by a sign-in on GitHub that comes straight back. The rule is unchanged: the ones the app reaches that the person's own account can write to.
- **Already installed? Check again** finds an installation an organisation's owner approved later, in a browser of their own.
- The two buttons sit above the repository list.

New route: `POST /api/setup/github-app/refresh`. The callback accepts a return that names no installation.
