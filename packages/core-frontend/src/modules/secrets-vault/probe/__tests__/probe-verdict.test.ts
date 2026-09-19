import { describe, it, expect } from 'vitest';
import { probeWords } from '../probe-verdict';
import { toolStatus } from '../../../library/utils/status';
import type { ProbeVerdict, ToolSecrets } from '../../services/tool-secrets.api';

/**
 * One verdict, one sentence — wherever the key was typed.
 *
 * Three surfaces save tool credentials and all three now probe afterwards. The
 * thing worth pinning is not that each renders SOMETHING, which their own
 * tests cover, but that they render the SAME thing: a person who saves a wrong
 * key on the Connect page and opens the tool page to fix it must meet one
 * complaint about one rejection, not two sentences they have to reconcile.
 *
 * So the words live in one function and every surface reads it. These tests
 * are what stops a well-meaning edit from giving one surface its own dialect.
 */

const at = new Date().toISOString();
const verdict = (over: Partial<ProbeVerdict> = {}): ProbeVerdict => ({
  status: 'ok',
  detail: null,
  checkedAt: at,
  ...over,
});

describe('probeWords', () => {
  it('earns Connected from a passing probe, and says when it was checked', () => {
    const w = probeWords(verdict({ status: 'ok' }));
    expect(w.tone).toBe('ok');
    expect(w.text).toBe('Connected');
    // The evidence, not just the claim: "Connected" backed by nothing is the
    // assumption this whole feature exists to remove.
    expect(w.hint).toMatch(/^Checked /);
  });

  it("quotes the provider's own words on a rejection, and goes loud", () => {
    const w = probeWords(verdict({ status: 'failed', detail: '401 Unauthorized: bad token' }));
    expect(w.tone).toBe('err');
    expect(w.text).toBe('Not working');
    expect(w.hint).toBe('401 Unauthorized: bad token');
  });

  it('still names a reason when a rejection arrives without one', () => {
    const w = probeWords(verdict({ status: 'failed', detail: null }));
    expect(w.tone).toBe('err');
    expect(w.hint).toBe('The provider rejected this credential.');
  });

  it('says Unverified — quietly — when the probe reached no verdict', () => {
    const w = probeWords(
      verdict({
        status: 'unverifiable',
        detail: "This tool doesn't offer a way to test its connection.",
      }),
    );
    // Quiet on purpose. The key is saved and nobody has to act; painting every
    // untestable integration amber teaches people that amber means nothing.
    expect(w.tone).toBe('ok');
    expect(w.text).toBe('Unverified');
    expect(w.hint).toBe("This tool doesn't offer a way to test its connection.");
  });

  it('still explains itself when an unverifiable verdict arrives without a reason', () => {
    const w = probeWords(verdict({ status: 'unverifiable', detail: null }));
    expect(w.text).toBe('Unverified');
    expect(w.hint).not.toBe('');
  });
});

/**
 * The tool page reaches these words through `toolStatus`, because its health
 * line also has to weigh the tool's unset variables. Everything else reaches
 * them through `probeWords` directly. Same verdict in, same words out.
 */
describe('the tool page and the rows agree, verdict for verdict', () => {
  const settled: ToolSecrets = {
    slug: 'github',
    name: 'github',
    path: 'Plugins/Engineering/github.tool',
    type: 'mcp',
    setup: null,
    canWrite: false,
    variables: [
      {
        name: 'API_KEY',
        scope: 'user',
        label: null,
        key: 'github_API_KEY',
        adminConfigured: true,
        userConfigured: true,
      },
    ],
  };

  const cases: ProbeVerdict[] = [
    verdict({ status: 'ok' }),
    verdict({ status: 'failed', detail: 'Invalid API key.' }),
    verdict({ status: 'unverifiable', detail: 'Provider timed out.' }),
  ];

  for (const v of cases) {
    it(`says the same thing about a ${v.status} verdict`, () => {
      const page = toolStatus(settled, v);
      const row = probeWords(v);
      expect(page.text).toBe(row.text);
      expect(page.hint).toBe(row.hint);
      expect(page.state).toBe(row.tone);
    });
  }

  /**
   * The one place they MUST differ: with nothing probed at all, the tool page
   * can still say what is stored. `Unverified` would be wrong there — nobody
   * asked, so there is nothing to be unverified about.
   */
  it('parts company only where no probe has run', () => {
    const page = toolStatus(settled);
    expect(page.text).toBe('Key saved');
    expect(page.state).toBe('ok');
  });
});

/**
 * The secret is not an input to any of this.
 *
 * The strongest guarantee available is structural rather than a string search:
 * `probeWords` takes the VERDICT alone, so no rendering built on it has the
 * submitted value to leak. The surfaces' own tests then check the rendered
 * document for the typed secret; this checks that the function cannot see one
 * even when the provider's own words are doing their best to look like it.
 */
describe('the submitted secret has no route into the words', () => {
  it('passes the provider detail through verbatim and invents nothing', () => {
    const detail = 'The API key ending in 4242 was rejected.';
    expect(probeWords(verdict({ status: 'failed', detail })).hint).toBe(detail);
  });

  it('takes a verdict and nothing else', () => {
    // One argument: there is no parameter through which a caller could hand it
    // the value that was saved, by accident or otherwise.
    expect(probeWords.length).toBe(1);
  });
});
