import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppRegistryContext, type AppRegistry } from '../../core/registry';
import { configureEmbed, type EmbedHandoff } from './embed-config';
import { EmbedView } from './components/EmbedView';

export interface MountEmbedOptions extends EmbedHandoff {
  /**
   * The deployment's registry — the same one its `CoreAppShell` is mounted
   * with — so a renderer the deployment registered (the enterprise `.html`
   * renderer) draws the page here exactly as on the file page.
   */
  registry: AppRegistry;
}

/**
 * Mount the embed OUTSIDE the app: into a document that is not one of the
 * deployment's pages, with the token and the deployment's origin handed in
 * rather than read from the page's URL.
 *
 * This is what the MCP App view calls after loading the deployment's embed
 * bundle into the chat host's sandbox. It cannot frame the deployment's
 * `/embed` page there (Claude pins the sandbox's `frame-src` to `'self'`), so
 * the app's renderers run in the sandbox document itself — the same
 * `EmbedView`, under the same registry, with every address prefixed by the
 * deployment's origin and every link handed to the host's `ui/open-link`.
 *
 * The router is in memory: the view never navigates, and the sandbox's own
 * address is not one the app's routes should read.
 */
export function mountEmbed(root: HTMLElement, options: MountEmbedOptions): { unmount(): void } {
  configureEmbed({
    origin: options.origin,
    token: options.token,
    openLink: options.openLink ?? null,
  });
  const reactRoot: Root = createRoot(root);
  reactRoot.render(
    <StrictMode>
      <AppRegistryContext.Provider value={options.registry}>
        <MemoryRouter>
          <EmbedView />
        </MemoryRouter>
      </AppRegistryContext.Provider>
    </StrictMode>,
  );
  return { unmount: () => reactRoot.unmount() };
}
