# Where the knowledge base lives

Everything in Hexis is kept in one git repository: knowledge, skills and
tools. A deployment can have that repository three ways. The setup screen
offers them as tabs, and the one open when you save is the one the
deployment is on.

| Way | What you enter | When to choose it |
| --- | --- | --- |
| **Managed for you** | Nothing | You want to start now, or have no git host |
| **GitHub** | Nothing; you pick the repository from a list | The repository is, or will be, on GitHub |
| **Address and token** | The repository's address and an access token | Any other git host, or a token you already have |

A deployment that was set up before there was a choice is on **Address and
token**, and stays there unless you open another tab and save.

Whichever way you choose, the rest works the same: every change is a
commit, and changes are reviewed as change requests inside Hexis.

## Managed for you

The deployment keeps the repository itself, on its own storage. There is
nothing to connect.

The repository is stored in the deployment's **backups** volume, under
`managed-repository/`. Backing that volume up backs the repository up, and
losing it loses the repository: it is the only copy that is not a working
copy. The shipped compose files all give backups a volume of its own.

The repository starts empty and is set up on first use, on a branch called
`main` unless you name another under Advanced.

The repository is not reachable from outside Hexis in this release.

## GitHub

The deployment reaches the repository through a GitHub App: an identity of
its own on GitHub, which you install on the repository. No access token is
created or stored. GitHub issues the deployment a token that lasts an hour,
and the deployment asks for a new one as it needs it.

Three steps, each offered once the one before is done:

1. **Create the GitHub App.** One press. GitHub asks you to confirm and
   creates an app that belongs to you, or to your organisation if you named
   one. It asks for read and write access to the contents of the
   repositories it is installed on, and nothing else.
2. **Install it.** On GitHub, choose the account or organisation and the
   repositories the app may reach. Choose only the one the knowledge base
   lives in.
3. **Choose the repository** from the list, and save.

An empty repository is fine: it is set up for you.

### Which repositories are in the list

The ones the app reaches **that your own GitHub account can write to**, as
they were when the list was last read. A repository the app reaches and you
cannot write to is not offered, and cannot be connected by typing its name.

Two buttons above the list keep it in step with GitHub:

- **Change repositories on GitHub** opens the app's settings on GitHub in
  another tab, where you choose which repositories it reaches. Save there,
  then come back to the tab Hexis is in.
- **Refresh the list** reads again what you can connect. It sends you to
  GitHub to sign in and straight back. Press it after changing repositories
  on GitHub, or after your own access changed: GitHub does not tell Hexis
  about either.

If an owner of your organisation approved the app after you asked for it,
press **Already installed? Check again** on the same tab.

If the app reaches no repository you can write to, nothing is connected and
the tab says so. Add one you can write to, or ask someone who can write to
it to connect GitHub.

### What you had entered is kept while you are on GitHub

Connecting GitHub takes your browser away and brings it back, twice. What
you had typed into the form before leaving is there when you return.

Secrets are the exception: an access token or an application secret you had
typed is not kept while the browser is away. The screen names the ones to
enter again.

What is kept stays in that browser tab, for half an hour.

### Your deployment must be reachable by your browser

GitHub sends your browser back to the deployment twice, at
`<PUBLIC_BACKEND_URL>/api/setup/github-app/…`. The deployment does not have
to be reachable from the internet, only from the browser you are using.

### Supplying your own GitHub App

Whoever operates the deployment can register the app themselves and supply
it through the environment, in place of the one the setup screen creates.
Set all five of `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID` and
`GITHUB_APP_CLIENT_SECRET`. The app needs:

- Repository permissions: **Contents** read and write, **Metadata** read.
- Callback URL: `<PUBLIC_BACKEND_URL>/api/setup/github-app/callback`.
- **Request user authorization (OAuth) during installation**: on.

That last setting is required. It is how the deployment learns which
repositories of the installation your own GitHub account can write to.

An installation supplied through `GITHUB_APP_INSTALLATION_ID` is the
operator's statement about their own deployment: everything it reaches can
be connected.

## Address and token

Any git host that serves https: GitHub, GitLab, Bitbucket, Azure DevOps or
your own. Enter the repository's address and a token with read and write
access, and press **Test connection**. See
[configuration.md](configuration.md) for the variables.

## Moving to another repository

A move is any save that puts the deployment on a different repository:
another tab, another address, or another repository on GitHub. Every move
works the same way.

Make the change and press **Save and continue**. Nothing moves yet: the
screen asks you to confirm at the button, naming the way you leave and the
way you move to. Opening a tab moves nothing either.

- **The move takes effect when you confirm.** No restart is needed.
- The deployment moves to the other repository, which starts without what
  the current one holds.
- Nothing is deleted. The repository you leave is untouched.
- What happens to the deployment's working copies depends on the
  repository you move to, not on your answers:
  - If it holds the same history (the same repository at a new address),
    the working copies are kept and pointed at it, with any work that was
    never pushed.
  - If it is a different repository, the working copies are set aside
    under `replaced-working-copies/` in the backups volume, with any work
    that was never pushed. Changes that were still waiting to be committed
    to them are held for an admin to look at, not committed to the new
    repository.
- If change requests are open, you choose: keep them open, when the same
  repository only moved, or close them as "repository replaced".

Cancel the question to stay where you are. To go back after a move, move
again to the repository you left.

To take history with you, push the old repository into the new one with
git before you move.

With `GIT_MODE` set in the environment, the choice is made there. The
other tabs are shown and cannot be opened.
