/**
 * The platform's shortest accepted password. The server reads it and refuses
 * a shorter one with a 400 rather than truncating. The Invite dialog's
 * starting-password field reads it too and holds Invite until it is met; the
 * other password forms (Account page, User accounts) do not check it
 * themselves and show the server's refusal instead.
 */
export const MIN_PASSWORD_LENGTH = 8;
