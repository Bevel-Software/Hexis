/**
 * What the workflow module offers the other modules: the addresses of its
 * change requests, so a module that lands a proposal can hand back a link
 * built by the one rule — rather than each spelling the route for itself;
 * and the live-event surface — the bus, the events route, and the delivery
 * rule every event passes on its way to a session. The services are wired by
 * the composition root.
 */
export { CHANGE_REQUEST_URL_NOTE, changeRequestLink, changeRequestLinkBase } from './git/change-request-link.js';
export { WorkflowEventBus } from './event-bus.js';
export { createEventsRoutes } from './events.routes.js';
export { EventDelivery, createEventAccess } from './events-delivery.js';
export type { EventAccess, EventViewer, IEventDelivery } from './events-delivery.js';
