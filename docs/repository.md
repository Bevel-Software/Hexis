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

To reach another repository later, use **Change which repositories the app
can reach** on the same tab.

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

That last setting is required. It is how the deployment checks that the
installation you come back with is one your GitHub account can reach.

## Address and token

Any git host that serves https: GitHub, GitLab, Bitbucket, Azure DevOps or
your own. Enter the repository's address and a token with read and write
access, and press **Test connection**. See
[configuration.md](configuration.md) for the variables.

## Moving to another repository

Open another tab and save. The screen says what that does before you press
the button:

- The deployment moves to the other repository, which starts without what
  the current one holds.
- Nothing is deleted. The repository you leave is untouched.
- The move takes effect at the next restart. The deployment's working
  copies of the repository it left are then set aside under
  `replaced-working-copies/` in the backups volume, with any work that was
  never pushed.

To take history with you, push the old repository into the new one with
git before you move.
