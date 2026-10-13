/**
 * The workspace's public surface for other modules: where the page lands once
 * the file on screen has closed, the "This file was deleted" notice and the
 * hook that says when an item on screen was deleted elsewhere, and the
 * workspace context those pages read the checkout from. Other modules import
 * them from here rather than reaching into the workspace's files.
 */
export { landingAfterClose } from './routing/landing';
export { DeletedFileNotice } from './components/DeletedFileNotice';
export { useItemDeletedElsewhere } from './hooks/useItemDeletedElsewhere';
export { WorkspaceContext } from './state/workspace.context';
