# Skills in Cowork and claude.ai

Claude Code and Codex install the platform's skills as native plugins from a
git remote. Cowork and claude.ai cannot: they accept marketplaces only from
GitHub, or from a GitHub Enterprise Server that your Claude organization has
registered. The platform answers as one, so those surfaces can install the
same marketplace. Each person gets the marketplace compiled for exactly what
they may read.

## What you need

- A Claude **Team or Enterprise** plan. Registering a GitHub Enterprise Server
  is an Owner action in Claude's admin settings and is not offered on personal
  plans.
- The platform reachable from the internet over HTTPS (Anthropic's servers
  fetch the marketplace from it).
- `SECRETS_ENC_KEY` set, since the registration credentials are stored sealed.

## Register the platform once (an Owner of your Claude organization)

1. In the platform, open **Deployment** and find **Claude connection**. It
   shows generated credentials: hostname, App ID, Client ID, client secret,
   webhook secret and private key.
2. In Claude, open **Admin settings → Claude Code**, scroll to **Self-hosted
   infrastructure**, and choose **Add manually** beside GitHub Enterprise.
   Paste the fields from step 1. Any display name will do, port 443 is right,
   and read replicas stay empty. Choose **Add configuration** to save them.

The webhook URL Claude generates can be ignored. Rotate the credentials from
the same card if they are ever exposed; the Owner then re-enters them.

Registering connects the platform to your Claude organization, not to any
person: every person, the Owner included, connects their own account before
they can add the marketplace.

## Add the marketplace (every person)

1. Connect your account. Claude does not prompt for this, and its
   **Connect to GitHub** button signs in to github.com, which is not it. Open
   Claude's **Admin settings → GitHub**, choose **Connect**, and under GitHub
   instance pick the registered platform instead of github.com; the
   repository picker on **claude.ai/code** offers the same connect option.
   You land on the platform's sign-in: approve, and you are back in Claude.
2. Copy the marketplace URL from **External agent access → Marketplaces**.
   It is the same URL Claude Code clones.
3. In Cowork (or claude.ai), open **Customize → Plugins**, then **Add → Add
   marketplace**, paste the URL and choose **Sync**.
4. Syncing lists the plugins, it installs none of them. Open **Discover** and
   choose **Add** on **hexis-all** for everything you may read in one plugin
   (every skill, and the knowledge base as an MCP server), or single plugins
   for a subset. **Update** in Claude pulls what changed.

Your connection appears under **Marketplaces → Your Claude connections**,
where you can disconnect it. Disconnecting stops updates; connecting again
from Claude resumes them. "Repository not found" or "GitHub access is
required" on the marketplace means Claude has no usable connection for your
account: step 1 has not happened, or the connection it made was since
disconnected here. Connect again from step 1; if that does not take, the
server log says why (below).

The same steps, with a screenshot of every screen, are on the **External agent
access** page in the app. The registration half is shown to admins only.

## When connecting does not take

Approving on the platform and landing back in Claude proves the browser
half. Claude's servers then exchange a code with the platform, and Claude
shows nothing when that exchange is refused. The platform's server log
does: every refused step is a line starting with `[github-facade]` naming
the check that failed, such as a client secret that no longer matches the
registration.

## Limits

- Marketplaces added by an Owner for the whole organization, and Claude's
  automatic sync, are not supported yet. Each person adds the marketplace from
  their own settings.
- The marketplace contains what you may read at the time Claude fetches it.
  Access changes reach Claude at the next update.
