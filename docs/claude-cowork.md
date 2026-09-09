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

## Register the platform once (admin, then a Claude Owner)

1. In the platform, open **Deployment** and find **Claude connection**. It
   shows generated credentials: hostname, App ID, Client ID, client secret,
   webhook secret and private key.
2. In Claude, go to **Admin settings → Claude Code → GitHub Enterprise
   Server** and choose **Add manually**. Paste the fields from step 1. Any
   display name will do.

The webhook URL Claude generates can be ignored. Rotate the credentials from
the same card if they are ever exposed; the Owner then re-enters them.

Registering connects the platform to your Claude organization, not to any
person: every person, the Owner included, connects their own account before
they can add the marketplace.

## Add the marketplace (every person)

1. Connect your account. Claude does not prompt for this, and its
   **Connect to GitHub** button signs in to github.com, which is not it. Use
   the connect option for the registered instance in the repository picker on
   **claude.ai/code**; an Owner also has it in the GitHub Enterprise Server
   section of the admin settings. You land on the platform's sign-in: approve,
   and you are back in Claude.
2. Copy the marketplace URL from **External agent access → Marketplaces**.
   It is the same URL Claude Code clones.
3. In Cowork (or claude.ai), open **Plugins → Add marketplace** and paste it.
4. Install the plugins you want. **Update** in Claude pulls what changed.

Your connection appears under **Marketplaces → Your Claude connections**,
where you can disconnect it. Disconnecting stops updates; connecting again
from Claude resumes them. "Repository not found" or "GitHub access is
required" on the marketplace means step 1 has not happened for your account.

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
