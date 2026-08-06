import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  DEFAULT_BRANCH,
  groupOfPath,
  type PullRequestSummary,
} from '@bevel-software/platform-shared';
import '../../library.css';
import { Badge, Button } from '../../../../shared/components';
import { useAuth } from '../../../auth/state/auth.context';
import { useWorkspace } from '../../../workspace/state/workspace.context';
import { kbFileUrl, resolveRelativePath, useNodeIdNav } from '../../../workspace/routing/kb-routes';
import { cancelPullRequest } from '../../../pr/services/pr-cancel.api';
import { proposeChange, suggestionBranchFor } from '../../services/library.api';
import { useSkillDetail } from '../../hooks/useSkillDetail';
import { useApplyChangeRequest } from '../../hooks/useApplyChangeRequest';
import { useCrFileDiffs } from '../../hooks/useCrFileDiffs';
import { useDefaultBranchFile } from '../../hooks/useDefaultBranchFile';
import { useLibrary } from '../../state/library-data';
import { useLibraryToast } from '../../state/toast.context';
import { LIBRARY_ROOT } from '../../routes/library-paths';
import { changeAuthorName } from '../../utils/cr-author';
import { ownersTextOf } from '../../utils/group-summary';
import { neededToolsFor, toolStatus } from '../../utils/status';
import { StatusDot } from '../StatusDot';
import { ChangeRequestDock } from '../ChangeRequestDock';
import { CompareView } from '../CompareView';
import { SkillFileTabs } from './SkillFileTabs';
import { skillPanelId, skillTabId } from './tab-ids';
import { SkillFilePane } from './SkillFilePane';
import { SkillFileEditor } from './SkillFileEditor';
import { SkillChangeBox } from './SkillChangeBox';

/**
 * One skill, as a page — the prototype's skill item (line 1964), which says of
 * itself: "the heading, its files, and the open file. Nothing else."
 *
 * It replaces the detail DIALOG for skills, and the reason it is a route is the
 * same reason the tool page is one: a skill is a thing you link to. A dialog has
 * no URL, so "look at the newsletter skill" could only ever be "open the
 * library, find the card, click it" — and the change-request flow that lands on
 * top of this page needs somewhere for a review link to point.
 *
 * One thing the prototype's page does NOT have is kept here, because dropping
 * it would remove function rather than chrome: the integrations the skill
 * needs (the only place a skill states what has to be connected before it
 * will run). The description is NOT repeated above the content anymore — the
 * file pane renders the RAW file, so the frontmatter panel already carries
 * `description` (and everything else the YAML says), exactly as the Knowledge
 * view would render the same file.
 */
export function SkillPage() {
  const { name: rawName = '' } = useParams<{ name: string }>();
  const name = safeDecode(rawName);
  const navigate = useNavigate();
  const toast = useLibraryToast();
  const { kbDirName } = useWorkspace();
  const { user } = useAuth();
  const data = useLibrary();
  const detail = useSkillDetail(name);
  // The same id-link resolver the Knowledge renderer uses — a `[text](node-id)`
  // link inside a skill file navigates to that node, not to a dead span.
  const { openNodeId } = useNodeIdNav();

  const [selected, setSelected] = useState('SKILL.md');
  const [compareCr, setCompareCr] = useState<PullRequestSummary | null>(null);
  /** Ties the tabs to the panel they control; unique per mounted page. */
  const tabsId = useId();

  // Ownership is a property of the CATALOG entry, not of the skill document —
  // it comes from the per-file ACL the provider already resolved, so the page
  // reads it rather than asking again.
  const owned = useMemo(
    () => data.items.some((i) => i.kind === 'skill' && i.id === name && i.owned),
    [data.items, name],
  );

  const skill = detail.skill;
  const skillPath = skill?.path ?? '';
  const prefix = `${skillPath}/`;

  /**
   * Who has to say yes. A skill has no owner of its own — it inherits its group
   * folder's `access.md` — so the people who review a change to it are the
   * group's owners. Naming the wrong reviewer is worse than naming none, hence
   * the neutral fallback when the group index hasn't resolved.
   */
  const ownerName = useMemo(() => {
    const group = skill ? groupOfPath(skill.path) : null;
    const summary = group ? data.groupSummaries.find((g) => g.name === group) : undefined;
    return summary ? ownersTextOf(summary) : 'the owner';
  }, [skill, data.groupSummaries]);

  const files = useMemo(
    () => ['SKILL.md', ...(skill?.files ?? []).map((f) => f.slice(prefix.length))],
    [skill, prefix],
  );

  /**
   * The file actually on screen. DERIVED rather than corrected in an effect: a
   * selection that no longer exists (a stale tab after a merge renamed the file,
   * or a skill switched underneath the page) resolves straight back to SKILL.md
   * on the same render, so the pane never paints a frame pointing at nothing.
   */
  const active = files.includes(selected) ? selected : 'SKILL.md';

  useEffect(() => {
    if (active !== 'SKILL.md') detail.loadFile(active);
    // `detail.loadFile` is keyed by (name, contents) and self-dedupes; widening
    // these deps re-runs it on every content arrival for no gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, skill]);

  const needed = useMemo(
    () => (skill ? neededToolsFor(skill, data.tools) : []),
    [skill, data.tools],
  );

  /** Open change requests touching anything inside this skill's folder. */
  const skillCrs = useMemo(
    () => (skillPath ? data.crs.filter((c) => touchesSkill(c, skillPath)) : []),
    [data.crs, skillPath],
  );
  /**
   * The caller's own open change request for this skill, resolved by BRANCH.
   *
   * Not by touched paths: `touchedNodePaths` is documented "Empty if not yet
   * computed", and while it is empty every path-derived check collapses at
   * once — the request stops looking like it touches this skill, so `ownCr`
   * goes null, the editor offers itself again, and `proposeChange` takes its
   * no-existing-request path and opens a SECOND change request against the
   * branch that already has one.
   *
   * The branch is deterministic (`suggestionBranchFor`) and exists from the
   * moment the request does, so it answers "is this mine?" in the window where
   * paths cannot. The path-based lookup stays as a fallback — it can only add
   * matches, never remove them — so a request opened on some other branch (by
   * an agent, say) is still recognised as the caller's.
   */
  const myBranch = user ? suggestionBranchFor(user.email, name) : null;
  const ownCr = useMemo(
    () =>
      data.crs.find((c) => data.myCrNumbers.has(c.number) && c.branch === myBranch) ??
      skillCrs.find((c) => data.myCrNumbers.has(c.number)) ??
      null,
    [data.crs, data.myCrNumbers, myBranch, skillCrs],
  );

  /** Which tabs get a dot: the files an open change request actually touches. */
  const pendingFiles = useMemo(() => {
    const set = new Set<string>();
    for (const cr of skillCrs) {
      for (const p of cr.touchedNodePaths) {
        if (p.startsWith(prefix)) set.add(p.slice(prefix.length));
      }
    }
    return set;
  }, [skillCrs, prefix]);

  const fileRepoPath = `${skillPath}/${active}`;

  /** Bumped after every write so the branch reads re-run against fresh content. */
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState(false);
  const [busyCr, setBusyCr] = useState<number | null>(null);
  /**
   * Change requests a merge attempt has REFUSED as unmergeable. Git is the only
   * thing that can answer "does this still apply?", and it answers when asked
   * to merge — so this fills in from failures rather than from a guess made up
   * front. Only CONFLICTS land here; a gate refusal ("waiting on approval
   * from …") is a state that can change under the reader, so it is reported
   * without withdrawing the button.
   */
  const [blockedCrs, setBlockedCrs] = useState<Set<number>>(new Set());

  /**
   * Approve = record the approvals, then merge, then wait for the merge to
   * actually happen. All three matter and none of them are the POST returning:
   * see `useApplyChangeRequest`.
   */
  const applying = useApplyChangeRequest({
    onApplied() {
      toast('Approved — the skill now reads with that change.');
      setRevision((r) => r + 1);
      data.reload();
      // The pane renders `skill.body`, which this hook holds and the merge just
      // changed. Without re-reading it the page keeps showing the pre-merge
      // text under a message saying the skill now reads with the change.
      detail.reload();
    },
    onFailed(number, refusal) {
      // A conflict is the one refusal that makes Approve pointless to retry, so
      // it withdraws the button — in the SAME commit as the refusal, which is
      // why this is not derived from `refusals` in an effect: a commit's delay
      // leaves the failed button live and clickable.
      if (refusal.conflicts) {
        setBlockedCrs((s) => (s.has(number) ? s : new Set(s).add(number)));
        toast('Blocked — the file changed after this was written.', 'danger');
      }
    },
  });

  /**
   * The file's raw bytes on the default branch. `raw` above is what gets
   * RENDERED (SKILL.md arrives from the skills API with its frontmatter already
   * parsed off); this is what gets diffed and edited. Mixing the two marks the
   * frontmatter as a deletion and, on submit, would commit it away.
   */
  const rawOnMain = useDefaultBranchFile(skillPath ? fileRepoPath : null, revision);

  /**
   * What the reading pane renders: the file's RAW bytes for every tab —
   * including SKILL.md, whose `skill.body` copy has had the frontmatter parsed
   * off by the skills API. The raw bytes are what make this pane render
   * IDENTICALLY to the Knowledge view of the same file: `KbMarkdownView`
   * parses the frontmatter itself and shows it as the panel above the body,
   * which is where the skill's description now lives (rather than being
   * repeated in the page header).
   */
  const raw = active === 'SKILL.md' ? rawOnMain : detail.fileContent(active);

  /** Every open change request's version of the file on screen. */
  const crDiffs = useCrFileDiffs(skillCrs, fileRepoPath, rawOnMain, revision);

  /** The change requests with something to say about THIS file. */
  const boxes = useMemo(
    () => skillCrs.filter((c) => c.touchedNodePaths.includes(fileRepoPath)),
    [skillCrs, fileRepoPath],
  );

  /**
   * Whether to offer the editor. Keyed off `ownCr` — which knows the caller's
   * request by branch — rather than off `boxes`, which cannot see a request
   * whose touched paths have not been computed yet and would hand out a second
   * editor over the top of one.
   *
   * Consequence worth knowing: one open proposal per person per SKILL, not per
   * file. Adding a second file to a request you already have open now means
   * withdrawing it (or asking your agent), which is the cost of never being
   * able to fork your own pending change in two.
   */
  const iAlreadyProposedHere = ownCr !== null;

  const openInEditor = useCallback(
    (wsRelative: string) => navigate(kbFileUrl(DEFAULT_BRANCH, wsRelative)),
    [navigate],
  );

  /**
   * A heading's citation deep-link — the file's KNOWLEDGE URL plus `#slug`,
   * because that is the surface that scrolls to a heading fragment. Same
   * affordance, same destination as copying the link from the Knowledge view
   * of this file; the two views must not hand out different URLs for the same
   * heading.
   */
  const headingLink = useCallback(
    (slug: string) =>
      kbDirName && skillPath
        ? `${window.location.origin}${kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/${skillPath}/${active}`)}#${slug}`
        : `${window.location.origin}${window.location.pathname}#${slug}`,
    [kbDirName, skillPath, active],
  );

  async function submitProposal(content: string) {
    if (!user) throw new Error('Sign in to propose a change.');
    await proposeChange({
      skillName: name,
      repoRelativePath: fileRepoPath,
      content,
      userEmail: user.email,
      userName: user.name,
      existingCr: ownCr,
    });
    setEditing(false);
    setRevision((r) => r + 1);
    toast(`Sent to ${ownerName} — nothing changes until they approve it.`);
    data.reload();
  }

  async function decline(cr: PullRequestSummary) {
    setBusyCr(cr.number);
    try {
      await cancelPullRequest(cr.number);
      toast('Declined. Nothing was changed.');
      data.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't decline this change.", 'danger');
    } finally {
      setBusyCr(null);
    }
  }

  async function withdraw(cr: PullRequestSummary) {
    setBusyCr(cr.number);
    try {
      await cancelPullRequest(cr.number);
      toast('Withdrawn.');
      data.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't withdraw this change.", 'danger');
    } finally {
      setBusyCr(null);
    }
  }

  const backLink = (
    <Button variant="quiet" size="sm" onClick={() => navigate(LIBRARY_ROOT)}>
      ‹ All skills &amp; tools
    </Button>
  );

  // Same frame as the other two branches: the way out is on screen while the
  // skill loads, not only once it has, and the column does not jump when the
  // content arrives under it.
  if (detail.loading) {
    return (
      <Article>
        {backLink}
        <p className="py-16 text-center text-ui text-ink-muted">Loading…</p>
      </Article>
    );
  }

  if (detail.error || !skill) {
    return (
      <Article>
        {backLink}
        <p className="mt-4 text-label font-semibold uppercase text-ink-faint">Skill</p>
        <p className="mt-2 text-body text-ink-muted">
          This skill doesn't exist, or you don't have access to it.
        </p>
      </Article>
    );
  }

  const group = groupOfPath(skill.path);

  // The compare view is a full-screen surface, not a layer over this page —
  // rendering both would leave the page's dock and tabs live underneath it.
  if (compareCr) {
    return (
      <CompareView
        skill={skill}
        cr={compareCr}
        onClose={() => setCompareCr(null)}
        onResolved={(kind) => {
          toast(kind === 'applied' ? 'Change request is being applied' : 'Sent back to the author');
          setCompareCr(null);
          data.reload();
        }}
      />
    );
  }

  return (
    <Article>
      {backLink}

      <header className="mt-4">
        <p className="text-label font-semibold uppercase text-ink-faint">
          {group ? `Skill · ${group}` : 'Skill'}
        </p>
        <div className="flex items-center gap-3">
          <h1 className="text-display font-semibold text-ink">{skill.name}</h1>
          {owned && (
            <Badge tone="outline" size="xs" className="shrink-0 uppercase">
              Owner
            </Badge>
          )}
        </div>
        {/* No description line here — the file pane renders the raw SKILL.md,
            and its frontmatter panel already says what the skill is for.
            Repeating it above the pane said the same sentence twice on the
            first screenful. */}
        {/* No `Manage access` here, deliberately — a skill inherits its group
            folder's `access.md`, and the group's Share panel is the one place
            those rules are decided. Same call the tool page made. */}
      </header>

      <IntegrationsSection needed={needed} onConnect={() => navigate('/connect')} />

      <SkillFileTabs
        files={files}
        selected={active}
        pending={pendingFiles}
        baseId={tabsId}
        onSelect={(f) => {
          setSelected(f);
          setEditing(false);
        }}
      />

      {/* The panel the tabs control. It wraps BOTH the reading pane and the
          editor that replaces it, so `aria-controls` resolves in either state
          rather than pointing at an element that exists only half the time. */}
      <div
        role="tabpanel"
        id={skillPanelId(tabsId)}
        aria-labelledby={skillTabId(tabsId, active)}
      >
      {editing && rawOnMain !== null ? (
        <SkillFileEditor
          file={active}
          base={rawOnMain}
          owner={ownerName}
          onCancel={() => setEditing(false)}
          onSubmit={submitProposal}
        />
      ) : (
        <SkillFilePane
          file={active}
          raw={raw}
          suggestion={null}
          onOpenLink={(href) => {
            if (!kbDirName) return;
            openInEditor(resolveRelativePath(`${kbDirName}/${skill.path}/${active}`, href));
          }}
          onOpenNodeId={openNodeId}
          headingLink={headingLink}
          /*
           * ONE action, deliberately. There used to be an `Edit` beside this
           * that jumped to the Knowledge app's editor on the default branch —
           * a direct commit, no review. Two adjacent buttons that both mean
           * "change this file" but differ on whether anyone gets to say no is
           * a trap, and it usually sprang: `main` is protected, so for everyone
           * without a write grant on the path that route ends in an
           * AccessDenied AFTER they have navigated away and typed the change.
           * Editing straight into the KB still exists in the Knowledge app; it
           * just stops being offered here as if it were the same thing.
           *
           * One open proposal per person per file, too — a second would fork
           * your own pending change into two decisions the owner must
           * reconcile.
           */
          actions={
            rawOnMain !== null &&
            !iAlreadyProposedHere && (
              <Button variant="outline" size="tiny" onClick={() => setEditing(true)}>
                Propose changes
              </Button>
            )
          }
        />
      )}

      {/* Every open proposal on this file, under the file it is about. The
          owner decides here; the author can take theirs back. */}
      {!editing &&
        boxes.map((cr) => {
          const mine = data.myCrNumbers.has(cr.number);
          // `[]` is the hook's "overtaken" answer — the proposal and the file
          // now say the same thing — and is distinct from `null`, which only
          // means a side has not arrived yet.
          const fileDiff = crDiffs.get(cr.number) ?? null;
          return (
            <SkillChangeBox
              key={cr.number}
              file={active}
              author={changeAuthorName(cr)}
              when={formatWhen(cr.createdAt)}
              mine={mine}
              canDecide={owned && !mine}
              diff={fileDiff}
              upToDate={fileDiff !== null && fileDiff.length === 0}
              blocked={blockedCrs.has(cr.number)}
              // A conflict already speaks through `blocked`; repeating it as a
              // refusal line would say the same thing twice in one box.
              refusal={
                applying.refusals.get(cr.number)?.conflicts === false
                  ? (applying.refusals.get(cr.number)?.reason ?? null)
                  : null
              }
              owner={ownerName}
              busy={busyCr === cr.number || applying.activeCr === cr.number}
              phase={applying.activeCr === cr.number ? applying.phase : 'idle'}
              onApprove={() => applying.apply(cr)}
              onDecline={() => void decline(cr)}
              onWithdraw={() => void withdraw(cr)}
              onOpenFull={owned ? () => setCompareCr(cr) : undefined}
            />
          );
        })}
      </div>

      {/* Outside the panel: the dock lists change requests touching ANY file of
          the skill, so it is not about the selected tab. The boxes above only
          cover the file on screen, and without this a proposal to a file you
          are not looking at has no way to reach you. */}
      {owned && <ChangeRequestDock crs={skillCrs} onSelect={setCompareCr} />}
    </Article>
  );
}

/** Does this change request touch anything inside the skill folder? */
function touchesSkill(cr: PullRequestSummary, skillPath: string): boolean {
  return cr.touchedNodePaths.some((p) => p === skillPath || p.startsWith(`${skillPath}/`));
}

/**
 * "today", "yesterday", or a plain date. A change box is read by someone
 * deciding whether to act now, and "3 Aug" answers that worse than "today"
 * does — but an exact timestamp answers it no better, so it stops there.
 */
function formatWhen(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'recently';
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * The reading column. Horizontal and vertical padding come from the Library
 * layout's `<main>`, which already wraps every page in the shared
 * `DOCUMENT_COLUMN` measure — the SAME 880px the Knowledge viewer uses. No
 * extra `max-w` here: narrowing this page below the measure made the same
 * document render at two widths depending on which surface opened it.
 */
function Article({ children }: { children: ReactNode }) {
  return <article className="w-full pb-14">{children}</article>;
}

/**
 * What has to be connected before this skill will run. Silent when the skill
 * needs nothing — a "Knowledge base only" row on most of the catalog is a line
 * of noise that pushes the file the reader came for below the fold.
 */
function IntegrationsSection({
  needed,
  onConnect,
}: {
  needed: ReturnType<typeof neededToolsFor>;
  onConnect(): void;
}) {
  if (needed.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="mb-2.5 text-label font-semibold uppercase text-ink-faint">
        Integrations this skill needs
      </h2>
      <div className="flex flex-col gap-1.5">
        {needed.map((t) => {
          const status = toolStatus(t);
          return (
            <div
              key={t.slug}
              className="flex items-center gap-3 rounded-md border border-line bg-sunken px-3 py-2"
            >
              <div className="min-w-0">
                <b className="block text-detail font-semibold text-ink">{t.name}</b>
                <small className="block text-meta text-ink-faint">
                  {status.state === 'ok' ? 'Connected — nothing to do' : status.text}
                </small>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {status.state === 'ok' ? (
                  <StatusDot state="ok" />
                ) : (
                  <Button variant="outline" size="tiny" onClick={onConnect}>
                    {status.state === 'err' ? 'Reconnect' : 'Connect'}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** A malformed escape is a bad link, not a crash — fall back to the raw segment. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
