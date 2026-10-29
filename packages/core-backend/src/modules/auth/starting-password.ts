import { randomInt } from 'node:crypto';

/**
 * The symbols a generated starting password is drawn from: letters and
 * digits without the ones read for each other when copied by eye (0 and O,
 * 1, l and I). 57 symbols, so 16 of them carry about 93 bits.
 */
export const STARTING_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** How many symbols a generated starting password has. */
export const STARTING_PASSWORD_LENGTH = 16;

/**
 * A starting password for an invited account, made on the server from the
 * operating system's cryptographic source (`crypto.randomInt`, uniform over
 * the alphabet). The caller hashes it, hands it once to the inviter and the
 * invited event, and never logs it.
 */
export function generateStartingPassword(): string {
  let out = '';
  for (let i = 0; i < STARTING_PASSWORD_LENGTH; i++) {
    out += STARTING_PASSWORD_ALPHABET[randomInt(STARTING_PASSWORD_ALPHABET.length)];
  }
  return out;
}
