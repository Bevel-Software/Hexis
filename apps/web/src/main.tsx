import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { addCollection } from '@iconify/react'
import materialIconTheme from '@iconify-json/material-icon-theme/icons.json'
import './index.css'
import {
  CoreAppShell,
  makeRegistry,
  loadServerConfig,
  renderConfigFailure,
} from '@bevel-software/platform-core-frontend'

addCollection(materialIconTheme)

/**
 * Core-only registry: no extra contributions — the shell runs the core
 * Knowledge (/workspace) and Skills & Tools (/skills-and-tools) apps, the
 * standalone settings pages (/secrets, /external-agent-access,
 * /roles-and-members, /tools, /connect) and the direct change-request
 * dialog. All of those are routed by the shell itself now, so the
 * standalone app has nothing to register.
 */
const registry = makeRegistry({})

const root = document.getElementById('root')!

/**
 * Configuration first, then render. The branch model arrives from the server
 * (`GET /api/config`) instead of being baked into this bundle, and every module
 * that reads `DEFAULT_BRANCH` expects it to be there — so the render waits.
 * A failure means the app cannot be configured at all, which is why it is
 * reported instead of mounting something that would only misbehave.
 */
loadServerConfig()
  .then(() => {
    createRoot(root).render(
      <StrictMode>
        <CoreAppShell registry={registry} />
      </StrictMode>,
    )
  })
  .catch((err) => renderConfigFailure(root, err))
