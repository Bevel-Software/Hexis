import { useCallback, useRef, useState } from 'react';
import { checkToolConnection, type ProbeVerdict } from '../services/tool-secrets.api';
import { PROBE_UNREACHABLE } from './probe-verdict';

/**
 * Probe a tool's credential after it is SAVED, and hold the answer.
 *
 * Lifted out of the tool page, which was the only surface doing this — the
 * Connect page and the vault stored a key and said nothing, so a mistyped one
 * looked exactly like a working one until an agent tripped over it hours
 * later. The lifecycle is subtle enough (two ordering hazards, both of which
 * produce a CONFIDENT WRONG ANSWER rather than a visible bug) that copying it
 * to two more surfaces was never the right move.
 *
 * What the hook is responsible for, and nothing else: run the probe, drop the
 * answers that no longer describe what is on screen, and never block the save.
 * The words belong to `probe-verdict.ts` and the layout to each surface.
 */

/**
 * A probe's answer: what the provider said, or that we never reached it.
 *
 * These are different in kind, which is why they are not one field. A verdict
 * is about the CREDENTIAL — the provider looked at it and decided. An
 * `unreachable` is about US: our network, our access, our timeout. Rendering
 * the second as though it were the first tells someone their key is wrong on
 * the evidence of our own trouble, and sends them off to rotate a key that was
 * fine.
 */
export type ProbeResult =
  | { kind: 'verdict'; verdict: ProbeVerdict }
  | { kind: 'unreachable'; message: string };

/**
 * WHICH configuration an answer is an answer about: the tool, and the revision
 * of its definition.
 *
 * The slug is half of it because a panel is not guaranteed to unmount when the
 * tool under it changes — the `.tool` editor's sidebar swaps `tool` on a
 * mounted `ToolSecretsPanel` — and a verdict left over from the previous tool
 * would then sit beside a variable of the same name on the new one, saying
 * `Connected` about a provider nobody has called. Keying the panel at each
 * caller would fix the callers that remembered to; carrying the slug here
 * fixes the ones that don't.
 */
interface Asked {
  slug: string;
  stamp: number;
}

/** An answer, with the configuration it is an answer ABOUT. */
interface Stamped extends Asked {
  result: ProbeResult;
}

export interface SavedKeyProbe {
  /**
   * The last answer, while it still describes the configuration on screen —
   * otherwise null. Never stale by construction: see `stamp`.
   */
  result: ProbeResult | null;
  /** The verdict specifically, for surfaces that only render that. */
  verdict: ProbeVerdict | null;
  /** A probe for the configuration on screen is in flight. */
  checking: boolean;
  /**
   * WHICH saved key the current answer is about, as the caller named it, or
   * null on a surface that never names one.
   *
   * A probe answers for the whole TOOL — one credential set, one call — but a
   * page of key rows has to put that answer somewhere, and the only honest
   * place is beside the key whose save asked the question. So one probe per
   * tool, and the rows render it only where `subject` points. Giving each row
   * its own probe instead would leave the first row saying `Connected` about a
   * credential set the second row has since changed: the same confident stale
   * claim this feature exists to remove, rebuilt one level down.
   */
  subject: string | null;
  /** Probe now — what a "Test connection" button calls. */
  run(): Promise<void>;
  /**
   * A key was just SAVED. Drops the previous answer first: it was about the
   * key this one replaced, and leaving it up for the round-trip means the old
   * key's `Connected` describing the new key's save.
   *
   * @param subject names the key that was saved, for surfaces that show the
   *   answer beside one of several rows.
   */
  probeSaved(subject?: string): void;
  /**
   * A credential write LANDED and no probe follows (a delete, or a caller that
   * re-probes on its own terms). Orphans anything in flight — after a delete,
   * `Connected` would otherwise arrive about a credential that no longer
   * exists.
   */
  forget(): void;
}

/**
 * @param slug  the tool to probe. Part of the identity of every answer the
 *   hook holds, so a caller that swaps tools without remounting (the `.tool`
 *   editor's sidebar) cannot show the previous tool's verdict beside the new
 *   tool's variables.
 * @param stamp the revision of the configuration being probed — bump it when
 *   the tool's DEFINITION changes (an edited MCP server: different endpoint,
 *   different headers). An answer is stored with the stamp it was asked under
 *   and read back only while that still matches, so a verdict about a server
 *   nobody is configured against any more simply stops showing. Comparing
 *   rather than clearing keeps it race-free: an effect that cleared on change
 *   would race the probe it is meant to protect, since a save starts a probe
 *   and a refetch at the same moment. Surfaces with no such notion pass
 *   nothing and every stamp is 0.
 */
export function useSavedKeyProbe(slug: string, stamp = 0): SavedKeyProbe {
  const [answer, setAnswer] = useState<Stamped | null>(null);
  /** What the probe in flight is about, or null — `checking` is DERIVED from it. */
  const [inFlight, setInFlight] = useState<Asked | null>(null);
  /** The key whose save the current answer belongs to, stamped like the answer. */
  const [subject, setSubject] = useState<(Asked & { name: string | null }) | null>(null);

  /**
   * Which probe is allowed to publish. Two saves in quick succession start two
   * probes, and the first can answer last — so a result is applied only while
   * it is still the newest one asked for. Without it the older key's verdict
   * wins by finishing late, which is the same stale-answer bug this feature
   * exists to remove, one layer up.
   */
  const seq = useRef(0);

  /** Is this what is on screen right now? */
  const current = (asked: Asked) => asked.slug === slug && asked.stamp === stamp;

  // In-flight against the CURRENT configuration only: a definition edit or a
  // tool switch mid-probe hands the button back immediately instead of waiting
  // for the orphan to settle.
  const checking = inFlight !== null && current(inFlight);
  const result = answer && current(answer) ? answer.result : null;

  const run = useCallback(async () => {
    const mine = ++seq.current;
    const asked: Asked = { slug, stamp };
    setInFlight(asked);
    // A replacement probe makes a previous TRANSPORT failure history the
    // moment it starts — leaving that alert up while "Testing…" runs reads as
    // the new attempt already having failed. A previous VERDICT stays: it is
    // still the last thing the provider said, and blanking it would make a
    // re-test look like it had lost the answer.
    setAnswer((prev) =>
      prev && prev.slug === asked.slug && prev.stamp === asked.stamp && prev.result.kind === 'verdict'
        ? prev
        : null,
    );
    try {
      const verdict = await checkToolConnection(slug);
      // Newest-probe guard only: everything published is STAMPED and compared
      // at render, so a probe that raced a definition change stores state that
      // simply never shows — no clock to synchronise, no ref read mid-render.
      //
      // A response with no verdict in it is treated as a probe we could not
      // run, not as a verdict. It should not happen — but rendering whatever
      // came back would throw inside the result component, and a malformed
      // answer to an optional question must not take down the page the person
      // is saving on.
      if (seq.current === mine) {
        setAnswer({
          ...asked,
          result: verdict
            ? { kind: 'verdict', verdict }
            : { kind: 'unreachable', message: PROBE_UNREACHABLE },
        });
      }
    } catch (err) {
      // A rejected credential RESOLVES with `status: 'failed'`; only a
      // transport or access failure lands here, and that is not a verdict about
      // the credential. Inside the guard too: an older probe rejecting after a
      // newer one answered would otherwise raise a transport error over a
      // verdict that is currently correct.
      if (seq.current === mine) {
        setAnswer({
          ...asked,
          result: {
            kind: 'unreachable',
            message: err instanceof Error && err.message ? err.message : PROBE_UNREACHABLE,
          },
        });
      }
    } finally {
      // Only the newest probe releases the slot: an older one finishing late
      // must not clear a newer probe's in-flight marker.
      if (seq.current === mine) setInFlight(null);
    }
  }, [slug, stamp]);

  const forget = useCallback(() => {
    seq.current++;
    setInFlight(null);
    setAnswer(null);
    setSubject(null);
  }, []);

  const probeSaved = useCallback(
    (nextSubject?: string) => {
      setAnswer(null);
      // The answer MOVES to the key that was just saved. It was never about
      // one key — a probe calls the provider with the whole credential set —
      // but the newest save is the only row where the claim is current, and a
      // stale one left behind on a sibling row is exactly the thing being
      // fixed here.
      setSubject({ slug, stamp, name: nextSubject ?? null });
      // NOT awaited, and never on the save's critical path: the value is already
      // stored by the time this is called, and a probe that hangs, fails or is
      // missing entirely must cost the person nothing. The floating promise is
      // the point.
      void run();
    },
    [run, slug, stamp],
  );

  return {
    result,
    verdict: result?.kind === 'verdict' ? result.verdict : null,
    checking,
    subject: subject && current(subject) ? subject.name : null,
    run,
    probeSaved,
    forget,
  };
}
