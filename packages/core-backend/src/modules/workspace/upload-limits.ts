/**
 * The deployment's own upload ceiling, in bytes.
 *
 * ONE number for every surface that accepts bytes: the app's
 * `POST /workspace/:id/upload` (a person dropping a file in the explorer) and
 * the agent upload route (`POST /agent/uploads/:token`). They used to be the
 * same number written twice, which is the shape a limit drifts in — an agent
 * refused at 50 MB by one route and accepted by the other would have no way to
 * read which limit applied. The refusal NAMES this value, so a caller can size
 * its next attempt from the answer rather than by bisection.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
