/** The presented embed token is missing, malformed, or expired. */
export class EmbedTokenError extends Error {
  constructor(message = 'Invalid or expired embed token') {
    super(message);
    this.name = 'EmbedTokenError';
  }
}

/**
 * The referenced file doesn't exist on the embed's target branch (→ 404).
 * Raised at mint time for a dead reference and at load time when the file was
 * renamed or removed after the token was minted. The message is user-facing —
 * it is what the embedded view shows for the reference.
 */
export class EmbedNodeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedNodeNotFoundError';
  }
}

/** The viewer lacks the access the operation needs on the default branch. */
export class EmbedAccessError extends Error {
  constructor(message = 'You do not have edit access to this file') {
    super(message);
    this.name = 'EmbedAccessError';
  }
}

/**
 * Another editor holds the file lock, so a save can't proceed (→ 409). Raised
 * when the viewer's own lock lapsed — a frame left hidden past the TTL — and
 * somebody else took the file in the meantime.
 */
export class EmbedLockedError extends Error {
  constructor(
    /** Display name / email of the current lock holder, for the UI. */
    public readonly heldBy: string,
  ) {
    super(`This file is currently being edited by ${heldBy}`);
    this.name = 'EmbedLockedError';
  }
}
