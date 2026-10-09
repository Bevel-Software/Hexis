import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppRegistryContext, type AppRegistry } from '../../core/registry';
import { configureEmbed, resetEmbedConfig, type EmbedHandoff } from './embed-config';
import { EmbedView } from './components/EmbedView';
import { ConfirmProvider } from '../../shared/components';

export interface MountEmbedOptions extends EmbedHandoff {
  /**
   * The deployment's registry — the same one its `CoreAppShell` is mounted
   * with — so a renderer the deployment registered (the enterprise `.html`
   * renderer) draws the page here exactly as on the file page.
   */
  registry: AppRegistry;
}

export interface EmbedMount {
  /** Take the embed down and hand the runtime back to the page's own answers. */
  unmount(): void;
}

/**
 * The one embed this document holds. The runtime the embed reads (see
 * `embed-config`) is per document, not per root, so there is one mount at a
 * time: a second `mountEmbed` takes the first down before it configures,
 * rather than leaving two views that read one token.
 */
let active: EmbedMount | null = null;

/**
 * Mount the embed OUTSIDE the app: into a document that is not one of the
 * deployment's pages, with the token and the deployment's address handed in
 * rather than read from the page's URL.
 *
 * This is what the MCP App view calls after loading the deployment's embed
 * bundle into the chat host's sandbox. It cannot frame the deployment's
 * `/embed` page there (Claude pins the sandbox's `frame-src` to `'self'`), so
 * the app's renderers run in the sandbox document itself — the same
 * `EmbedView`, under the same registry, with every address prefixed by the
 * deployment's address and every link handed to the host's `ui/open-link`.
 *
 * The router is in memory: the view never navigates, and the sandbox's own
 * address is not one the app's routes should read.
 */
export function mountEmbed(root: HTMLElement, options: MountEmbedOptions): EmbedMount {
  active?.unmount();
  configureEmbed({
    baseUrl: options.baseUrl,
    token: options.token,
    openLink: options.openLink ?? null,
  });
  const reactRoot: Root = createRoot(root);
  reactRoot.render(
    <StrictMode>
      <AppRegistryContext.Provider value={options.registry}>
        <MemoryRouter>
          {/* A link in an embedded email still asks before it opens — and a
              host's sandbox may refuse the browser's own dialog outright. */}
          <ConfirmProvider>
            <EmbedView />
          </ConfirmProvider>
        </MemoryRouter>
      </AppRegistryContext.Provider>
    </StrictMode>,
  );
  const mount: EmbedMount = {
    unmount() {
      reactRoot.unmount();
      // Only the mount that owns the runtime gives it back: a handle that
      // was already replaced must not reset what its successor configured.
      if (active === mount) {
        active = null;
        resetEmbedConfig();
      }
    },
  };
  active = mount;
  return mount;
}
