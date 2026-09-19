import { formatRelativeTime } from '../../../lib/utils';
import type { ProbeVerdict } from '../services/tool-secrets.api';

/**
 * The WORDS a probe's answer is said in — one set, for every surface that
 * saves a key.
 *
 * Three surfaces store tool credentials (the tool page, "Connect your tools",
 * the vault) and all three now probe afterwards. They must not describe the
 * same verdict differently: a person who saves a wrong key on the Connect page
 * and then opens the tool page to fix it would otherwise meet two sentences
 * about one provider's single rejection and have to work out whether they are
 * the same problem. So the vocabulary lives here and the renderings import it,
 * rather than each surface writing its own.
 *
 * The rule the words follow is the Library's: a claim may only be as strong as
 * the evidence behind it. `Connected` is earned by a call the provider
 * answered. `Not working` is the provider's own verdict, quoted. `Unverified`
 * is the honest word for everything else — there is nothing to call, or the
 * call could not reach one.
 */

/** Earned by a passing probe, and by nothing else. */
export const CONNECTED_TEXT = 'Connected';

/** The provider refused the credential. */
export const REJECTED_TEXT = 'Not working';

/**
 * We do not know. Note this is NOT an error state: the key is saved, nothing
 * needs a person, and painting every untestable integration amber would teach
 * people that amber means nothing.
 */
export const UNVERIFIED_TEXT = 'Unverified';

/** When a rejection arrives without the provider's own words. */
export const REJECTED_FALLBACK = 'The provider rejected this credential.';

/**
 * When `unverifiable` arrives without a reason. The backend names one in every
 * case it knows (`This tool doesn't offer a way to test its connection.` for a
 * manual with no health check), so this stands in only for a verdict that
 * dropped its detail on the way.
 */
export const UNVERIFIED_FALLBACK = "This tool doesn't offer a way to test its connection.";

/** The probe could not be RUN — transport, access. Never a verdict about the key. */
export const PROBE_UNREACHABLE = "Couldn't test this connection.";

/** A saved key whose check could not run: stored, and still unknown. */
export const PROBE_UNREACHABLE_LEAD = 'Saved, but not tested.';

/** `err` gets a person's attention; `ok` stays quiet. Same two the Library uses. */
export type ProbeTone = 'ok' | 'err';

export interface ProbeWords {
  tone: ProbeTone;
  /** The state, in one or two words. */
  text: string;
  /** The single line behind the word: what the provider said, or why we can't say. */
  hint: string;
}

/**
 * One verdict, in the words every surface says it in.
 *
 * `hint` is never empty — a word with nothing behind it is the assumption this
 * whole feature exists to remove, so even `Connected` carries when it was
 * checked.
 *
 * Deliberately takes the verdict ALONE. It cannot see the secret that was
 * submitted, so no rendering built on it can leak one; the only free text it
 * passes through is `detail`, which the server composes from the provider's
 * status line.
 */
export function probeWords(verdict: ProbeVerdict): ProbeWords {
  if (verdict.status === 'ok') {
    // The app's one relative-time formatter, not a local dialect of it. A
    // verdict with no usable timestamp still just happened — it cannot outlive
    // the component holding it — so "just now" is the honest fallback.
    return {
      tone: 'ok',
      text: CONNECTED_TEXT,
      hint: `Checked ${formatRelativeTime(verdict.checkedAt) || 'just now'}.`,
    };
  }
  if (verdict.status === 'failed') {
    return { tone: 'err', text: REJECTED_TEXT, hint: verdict.detail ?? REJECTED_FALLBACK };
  }
  return { tone: 'ok', text: UNVERIFIED_TEXT, hint: verdict.detail ?? UNVERIFIED_FALLBACK };
}
