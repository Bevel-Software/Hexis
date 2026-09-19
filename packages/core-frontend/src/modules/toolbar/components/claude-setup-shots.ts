/**
 * The screenshots behind the Cowork / claude.ai setup steps, and the one
 * thing to click in each.
 *
 * Highlights are PERCENTAGES of the image, never pixels. The shots are
 * normalized to 1400x1080 webp on the way in (see the asset README) and they
 * render into a ~700px column, so a pixel offset would be wrong at every size
 * except the one it was measured at.
 *
 * `new URL(…, import.meta.url)` rather than `import shot from './x.webp'`:
 * this package ships raw TS and is compiled by whatever bundler the host app
 * runs, and the URL form resolves there without a `*.webp` module
 * declaration to keep `tsc` happy. Each path is a literal because that is
 * the only form a bundler can rewrite statically.
 *
 * The shots are of a real deployment. Names, handles and third-party
 * organisations in them are blurred at build time (see the sibling
 * `README.md`): this package is published, so every deployment shows them.
 */

/**
 * A click target, as PERCENTAGES (0–100) of the image's width and height —
 * `ScreenshotStep` writes them straight into `left: x%`, so `0.881` would be
 * a box a hundredth of the size meant.
 */
export interface ShotHighlight {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Shot {
  src: string;
  /** Names the screen AND the highlighted control: the box is decoration. */
  alt: string;
  boxes: ShotHighlight[];
  /**
   * Intrinsic size, when this shot is not the default 1400x1080. Only the
   * ASPECT matters — the image renders at the column's width either way —
   * but the ratio has to be the file's own, or the reserved space collapses
   * to the right height only after the bytes arrive. A dialog is a shorter
   * screen than a full window, and cropping it to 1080 would be padding.
   */
  width?: number;
  height?: number;
}

/**
 * Intrinsic size of the nine window shots, so the column reserves the space
 * before load. A shot that is not this shape carries its own `width`/`height`.
 */
export const SHOT_WIDTH = 1400;
export const SHOT_HEIGHT = 1080;

export const addManuallyShot: Shot = {
  src: new URL('../assets/claude-setup/01-add-manually.webp', import.meta.url).href,
  alt: "Claude's admin settings, Claude Code page: the Add manually button beside GitHub Enterprise, under Self-hosted infrastructure.",
  boxes: [{ x: 88.1, y: 80.5, w: 10.9, h: 3.7 }],
};

export const addConfigurationShot: Shot = {
  src: new URL('../assets/claude-setup/02-add-configuration.webp', import.meta.url).href,
  alt: 'The Add GitHub Enterprise dialog: the GitHub App credential fields, and the Add configuration button that saves them.',
  boxes: [
    { x: 30.0, y: 43.7, w: 39.8, h: 33.6 },
    { x: 57.3, y: 94.4, w: 12.5, h: 3.9 },
  ],
};

export const connectAccountShot: Shot = {
  src: new URL('../assets/claude-setup/03-connect-account.webp', import.meta.url).href,
  alt: "Claude's admin settings, GitHub page: the Connect button above the list of connected GitHub accounts.",
  boxes: [{ x: 88.9, y: 16.7, w: 8.7, h: 3.7 }],
};

export const pickInstanceShot: Shot = {
  src: new URL('../assets/claude-setup/04-pick-instance.webp', import.meta.url).href,
  alt: 'The Install the Claude Code GitHub App dialog, with the GitHub instance list open on the row naming this deployment rather than github.com.',
  boxes: [{ x: 37.8, y: 76.9, w: 24.3, h: 4.2 }],
};

export const selectRepositoryShot: Shot = {
  src: new URL('../assets/claude-setup/09-select-repository.webp', import.meta.url).href,
  alt: 'Claude Code on the web, with the Select repository button highlighted below the empty session area.',
  boxes: [{ x: 38.7, y: 87.3, w: 13.6, h: 3.8 }],
};

export const pluginsAddShot: Shot = {
  src: new URL('../assets/claude-setup/05-plugins-add.webp', import.meta.url).href,
  alt: 'The Customize screen, with the Plugins tab and the Add button above the list highlighted.',
  boxes: [
    { x: 40.3, y: 11.8, w: 6.2, h: 3.9 },
    { x: 89.7, y: 11.8, w: 6.8, h: 3.9 },
  ],
};

export const addMarketplaceShot: Shot = {
  src: new URL('../assets/claude-setup/06-add-marketplace.webp', import.meta.url).href,
  alt: 'The Add menu open on the Customize screen, with Add marketplace at the top.',
  boxes: [{ x: 79.8, y: 16.5, w: 15.6, h: 3.5 }],
};

export const pasteUrlShot: Shot = {
  src: new URL('../assets/claude-setup/07-paste-url-sync.webp', import.meta.url).href,
  alt: 'The Add marketplace dialog: the URL field holding the marketplace address, and the Sync button that fetches it.',
  boxes: [
    { x: 21.8, y: 52.5, w: 56.5, h: 4.1 },
    { x: 72.8, y: 62.1, w: 5.3, h: 3.8 },
  ],
};

export const installPluginsShot: Shot = {
  src: new URL('../assets/claude-setup/08-install-plugins.webp', import.meta.url).href,
  alt: 'The Discover list after a sync, with the whole Hexis all row highlighted as the bundle that installs everything at once.',
  boxes: [{ x: 27.0, y: 32.1, w: 69.4, h: 7.5 }],
};

/**
 * The two connector shots. Installing the plugin is not the end of the
 * setup: its MCP server is a connector Claude adds separately, and these are
 * the screen that says so and the dialog that does it. Both are 1400x700 —
 * a plugin panel and a dialog, not a full window — so they declare their own
 * size rather than being padded to the window shots' 1080.
 */
export const connectorNotAddedShot: Shot = {
  src: new URL('../assets/claude-setup/10-connector-not-added.webp', import.meta.url).href,
  alt: "The Hexis all plugin's Tools and data sources list, with the hexis MCP server row reading Not added beside the Add for your team button.",
  boxes: [
    { x: 66.0, y: 30.9, w: 8.9, h: 6.0 },
    { x: 76.3, y: 29.7, w: 17.7, h: 8.0 },
  ],
  width: 1400,
  height: 700,
};

export const addCustomConnectorShot: Shot = {
  src: new URL('../assets/claude-setup/11-add-custom-connector.webp', import.meta.url).href,
  alt: "Claude's Add custom connector dialog, with the name and remote MCP server URL already filled in, and the Continue button that submits them.",
  boxes: [
    { x: 26.7, y: 28.6, w: 46.6, h: 25.7 },
    { x: 63.1, y: 76.3, w: 10.6, h: 8.3 },
  ],
  width: 1400,
  height: 700,
};
