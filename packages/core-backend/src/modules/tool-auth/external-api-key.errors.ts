/**
 * Domain errors for the API token service. Distinct classes so callers can
 * map each to an HTTP status and a user-facing message without string-matching.
 */

export class InvalidTokenLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenLabelError';
  }
}

export class TokenNotFoundError extends Error {
  constructor(message = 'Token not found') {
    super(message);
    this.name = 'TokenNotFoundError';
  }
}

export class TokenStillActiveError extends Error {
  constructor(message = 'Disconnect this key before deleting it') {
    super(message);
    this.name = 'TokenStillActiveError';
  }
}
