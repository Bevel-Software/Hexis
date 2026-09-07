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
3. When Claude asks you to connect your GitHub Enterprise account, you land on
   the platform's sign-in. Approve, and you are back in Claude.

The webhook URL Claude generates can be ignored. Rotate the credentials from
the same card if they are ever exposed; the Owner then re-enters them.

## Add the marketplace (every person)

1. Copy the marketplace URL from **External agent access → Marketplaces**.
   It is the same URL Claude Code clones.
2. In Cowork (or claude.ai), open **Plugins → Add marketplace** and paste it.
3. Connect your account when asked. You sign in on the platform and approve.
4. Install the plugins you want. **Update** in Claude pulls what changed.

Your connection appears under **Marketplaces → Your Claude connections**,
where you can disconnect it. Disconnecting stops updates; connecting again
from Claude resumes them.

## Limits

- Marketplaces added by an Owner for the whole organization, and Claude's
  automatic sync, are not supported yet. Each person adds the marketplace from
  their own settings.
- The marketplace contains what you may read at the time Claude fetches it.
  Access changes reach Claude at the next update.
