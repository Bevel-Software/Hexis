/**
 * Put an account back to "brand new" so the onboarding can be tested again.
 *
 *   node scripts/reset-onboarding.cjs [email]     (default: juan@bevel.software)
 *
 * Done is one-way over the API on purpose — "not onboarded again" is not a
 * state a user can be put in — so this is the DB-side undo, for development.
 *
 * IMPORTANT: this only resets the server half. The one-time greeting is
 * remembered per-browser in localStorage, so the welcome page will NOT
 * reappear until that is cleared too. Run this in the browser console:
 *
 *   Object.keys(localStorage)
 *     .filter(k => k.startsWith('bevel.onboarding.'))
 *     .forEach(k => localStorage.removeItem(k));
 *
 * …then reload. The script prints the same reminder when it finishes.
 */
const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

const email = process.argv[2] || 'juan@bevel.software';
const envPath = path.resolve(__dirname, '../../../.env');
// Read defensively: an absent (or unreadable) .env is the ORDINARY case for a
// fresh clone, and `readFileSync` throwing would answer it with an ENOENT
// stack trace — the one shape of output that says nothing about what to do
// next. Both endings are the same sentence: here is the path, put a
// DATABASE_URL in it.
let env = '';
try {
  env = fs.readFileSync(envPath, 'utf8');
} catch {
  console.error(`No readable .env at ${envPath}`);
  process.exit(1);
}
const match = env.match(/^DATABASE_URL=(.*)$/m);
if (!match) {
  console.error(`No DATABASE_URL in ${envPath}`);
  process.exit(1);
}

const client = new Client({ connectionString: match[1].trim() });
client
  .connect()
  .then(() => client.query('UPDATE users SET onboarding_done = false WHERE email = $1', [email]))
  .then((res) => {
    if (!res.rowCount) {
      console.log(`No such user: ${email}`);
      return;
    }
    console.log(`Server: ${email} is onboarding again.`);
    console.log('Browser: also clear the greeting, or only the pill comes back —');
    console.log(
      "  Object.keys(localStorage).filter(k=>k.startsWith('bevel.onboarding.')).forEach(k=>localStorage.removeItem(k))",
    );
  })
  .catch((err) => console.error('Failed:', err.message))
  .finally(() => client.end());
