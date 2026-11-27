/**
 * What the review module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move.
 */
export { ReviewContext, useReview, type ReviewContextValue } from './state/review.context';
