/**
 * The platform's shortest accepted password. One policy, read by the server
 * (which refuses a shorter one with a 400 rather than truncating) and by every
 * form that asks for a password (which holds its submit until it is met).
 */
export const MIN_PASSWORD_LENGTH = 8;
