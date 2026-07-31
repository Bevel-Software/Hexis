import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { addCollection } from '@iconify/react'
import materialIconTheme from '@iconify-json/material-icon-theme/icons.json'
import './index.css'
import { AuthGate, CoreAppShell, makeRegistry } from '@bevel-software/core-frontend'
import { ToolsExplorerPage } from '@bevel-software/core-frontend/src/modules/tools/ToolsExplorerPage.tsx'

addCollection(materialIconTheme)

/**
 * Core-only registry: no extra contributions — the shell runs the core
 * explorer/viewer panes, the Library, secrets, roles admin and the direct
 * change-request dialog.
 *
 * The one addition is the `/tools` explorer route: the tools MODULE is core,
 * but its route is registered by the composing app (in the enterprise build it
 * comes from the enterprise registry), so the standalone shell registers it
 * itself — the gear menu's "Browse available tools" row navigates here.
 */
const registry = makeRegistry({
  topLevelRoutes: [
    {
      path: '/tools',
      element: (
        <AuthGate>
          <ToolsExplorerPage />
        </AuthGate>
      ),
    },
  ],
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CoreAppShell registry={registry} />
  </StrictMode>,
)
