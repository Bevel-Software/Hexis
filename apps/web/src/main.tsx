import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { addCollection } from '@iconify/react'
import materialIconTheme from '@iconify-json/material-icon-theme/icons.json'
import './index.css'
import { CoreAppShell, makeRegistry } from '@bevel-software/core-frontend'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CoreAppShell registry={registry} />
  </StrictMode>,
)
