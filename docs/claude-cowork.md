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
   and read replicas stay empty.

The webhook URL Claude generates can be ignored. Rotate the credentials from
the same card if they are ever exposed; the Owner then re-enters them.

## Connect your account (every person)

Registering the instance signs nobody in, and Claude never prompts for it, so
this comes before the marketplace.

- Everyone: in the repository picker on claude.ai/code, use the connect option
  for this deployment.
- An Owner can also do it from **Admin settings → GitHub**: choose **Connect**,
  then pick this deployment under **GitHub instance** rather than github.com.

Either way you land on the platform's sign-in. Approve, and you are back in
Claude.

## Add the marketplace (every person)

1. Copy the marketplace URL from **External agent access → Marketplaces**.
   It is the same URL Claude Code clones.
2. In Cowork (or claude.ai), open **Customize → Plugins**, then **Add → Add
   marketplace**, paste the URL and choose **Sync**.
3. Syncing lists the plugins, it installs none of them. Open **Discover** and
   choose **Add** on each one you want. The bundle plugin (`hexis-all`)
   installs everything you may read at once. **Update** in Claude pulls what
   changed.

Your connection appears under **Marketplaces → Your Claude connections**,
where you can disconnect it. Disconnecting stops updates; connecting again
from Claude resumes them.

The same steps, with a screenshot of every screen, are on the **External agent
access** page in the app. The registration half is shown to admins only.

## Limits

- Marketplaces added by an Owner for the whole organization, and Claude's
  automatic sync, are not supported yet. Each person adds the marketplace from
  their own settings.
- The marketplace contains what you may read at the time Claude fetches it.
  Access changes reach Claude at the next update.
