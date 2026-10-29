/**
 * What the version-control module offers the other modules: the addresses of its
 * change requests, so a module that lands a proposal can hand back a link
 * built by the one rule — rather than each spelling the route for itself;
 * and the live-event surface — the bus, the events route, and the delivery
 * rule every event passes on its way to a session. The services are wired by
 * the composition root.
 */
export { CHANGE_REQUEST_URL_NOTE, changeRequestLink, changeRequestLinkBase } from './git/change-request-link.js';
export { VersionControlEventBus } from './event-bus.js';
export { createEventsRoutes } from './events.routes.js';
export { EventDelivery, createEventAccess } from './events-delivery.js';
export type { ChangeRequestFacts, EventAccess, EventViewer, IEventDelivery } from './events-delivery.js';
// Reached by other modules; exported here so they stop importing the files.
export { NodeGitRunner } from './git/node-git-runner.js';
export { RECOVERY_BOT_EMAIL } from './recovery-bot.js';
export type { IChangeRequestReviewService } from './change-request-review/change-request-review.interface.js';
export { sanitizeError } from './sanitize-error.js';
export type { VersionControlHooks } from './version-control-hooks.js';
export type { VersionControlService } from './version-control.service.js';
