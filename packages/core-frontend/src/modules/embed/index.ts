/**
 * The embed's public surface: what mounts a page inside a chat host
 * (`mountEmbed` and the handoff it reads), and the routes the shell mounts
 * for it. Other code imports these from here rather than reaching into the
 * embed's files.
 */
export { EmbedLinkPage } from './components/EmbedLinkPage';
export { EmbedView } from './components/EmbedView';
export { EMBED_HANDOFF_GLOBAL, type EmbedHandoff, readEmbedHandoff } from './embed-config';
export { mountEmbed, type MountEmbedOptions } from './mount';
