import './index.css'
import { makeRegistry, mountEmbed, readEmbedHandoff } from '@bevel-software/platform-core-frontend'

/**
 * The embed bundle: the knowledge-base page shown INSIDE a chat.
 *
 * The MCP App view (core-backend's `mcp-app/page.html`) runs in the chat
 * host's sandbox, where no frame to this deployment is allowed, so instead of
 * framing `/embed` it loads this bundle into its own document — found through
 * `/embed-manifest.json`, which the Vite build writes beside it — after
 * leaving the page's token, this deployment's origin and the host's
 * `ui/open-link` on the window. This entry reads that handoff and mounts the
 * same `EmbedView` the `/embed` route renders, under this app's registry, so
 * the page is drawn by the same renderers as on the file page.
 *
 * Loaded any other way there is nothing to show, and the page says so rather
 * than failing somewhere inside a renderer.
 */
const root = document.getElementById('root')!
const handoff = readEmbedHandoff()

if (handoff) {
  mountEmbed(root, { registry: makeRegistry({}), ...handoff })
} else {
  root.textContent = 'This is the embed bundle a chat view loads to show a knowledge-base page. It has nothing to show on its own.'
}
