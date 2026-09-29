---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

A deployment can have the repository its knowledge base lives in three ways, chosen on the setup screen:

- **Managed for you.** The deployment keeps the repository itself, in its backups volume. Nothing to enter.
- **GitHub.** A repository on GitHub, reached through a GitHub App the deployment registers in one press and the admin installs. No access token is created or stored.
- **Address and token.** Any git host, as before.

A deployment that is already set up stays on the way it has. Moving to another repository takes effect at the next restart and deletes nothing: working copies of the repository that was left are set aside, unpushed work included.

New variables: `GIT_MODE`, `GITHUB_APP_REPOSITORY`, and `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_INSTALLATION_ID` for an operator who supplies their own GitHub App. See `docs/repository.md`.

For distributions: `CoreServices` gains `repositorySource`, `managedRepository` and `githubApp`, and `GitCredentials` gains an optional `prepare()` that the git runner awaits before each call.
