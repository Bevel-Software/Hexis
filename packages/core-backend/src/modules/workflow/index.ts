/**
 * What the workflow module offers the other modules: the addresses of its
 * change requests, so a module that lands a proposal can hand back a link
 * built by the one rule — rather than each spelling the route for itself.
 * The services are wired by the composition root.
 */
export { CHANGE_REQUEST_URL_NOTE, changeRequestLink, changeRequestLinkBase } from './git/change-request-link.js';
