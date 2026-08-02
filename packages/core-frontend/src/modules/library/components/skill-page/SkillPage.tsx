import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  DEFAULT_BRANCH,
  groupOfPath,
  type PullRequestSummary,
} from '@bevel-software/platform-shared';
import '../../library.css';
import { Badge, Banner, Button } from '../../../../shared/components';
import { useAuth } from '../../../auth/state/auth.context';
import { useWorkspace } from '../../../workspace/state/workspace.context';
import { kbFileUrl, resolveRelativePath } from '../../../workspace/routing/kb-routes';
import { cancelPullRequest } from '../../../pr/services/pr-cancel.api';
import { readFileOnBranch, suggestChange } from '../../services/library.api';
import { useSkillDetail } from '../../hooks/useSkillDetail';
import { useLibrary } from '../../state/library-data';
import { useLibraryToast } from '../../state/toast';
import { LIBRARY_ROOT } from '../../routes/library-paths';
import { diffLines, hasChanges, type DiffLine } from '../../utils/diff';
import { neededToolsFor, toolStatus } from '../../utils/status';
import { StatusDot } from '../StatusDot';
import { ChangeRequestDock } from '../ChangeRequestDock';
import { CompareView } from '../CompareView';
import { SuggestChange } from '../SuggestChange';
import { SkillFileTabs } from './SkillFileTabs';
import { SkillFilePane } from './SkillFilePane';

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
 * Two things the prototype's page does NOT have are kept here, because dropping
 * them would remove function rather than chrome: the description (the one
 * sentence saying what the skill is for) and the integrations it needs (the
 * only place a skill states what has to be connected before it will run).
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

  const [selected, setSelected] = useState('SKILL.md');
  const [compareCr, setCompareCr] = useState<PullRequestSummary | null>(null);
  const fileViewRef = useRef<HTMLDivElement>(null);

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

  const raw = active === 'SKILL.md' ? (skill?.body ?? null) : detail.fileContent(active);

  const needed = useMemo(
    () => (skill ? neededToolsFor(skill, data.tools) : []),
    [skill, data.tools],
  );

  /** Open change requests touching anything inside this skill's folder. */
  const skillCrs = useMemo(
    () => (skillPath ? data.crs.filter((c) => touchesSkill(c, skillPath)) : []),
    [data.crs, skillPath],
  );
  const ownCr = useMemo(
    () => skillCrs.find((c) => data.myCrNumbers.has(c.number)) ?? null,
    [skillCrs, data.myCrNumbers],
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

  // The caller's own pending suggestion, read off its branch and diffed against
  // what is on the default branch right now.
  const [branchRevision, setBranchRevision] = useState(0);
  const fileRepoPath = `${skillPath}/${active}`;
  const ownCrTouchesFile = ownCr !== null && ownCr.touchedNodePaths.includes(fileRepoPath);

  /**
   * Stored WITH the request it answers, so switching tabs cannot show the
   * previous file's branch content for a frame. The alternative — clearing the
   * state at the top of the effect — is a synchronous setState in an effect
   * body, which costs a cascading render on every tab click; keying it means
   * the stale value simply stops matching and reads as absent.
   */
  const branchKey = `${ownCr?.branch ?? ''}::${fileRepoPath}::${branchRevision}`;
  const [branchFile, setBranchFile] = useState<{ key: string; content: string } | null>(null);
  const branchRaw = branchFile?.key === branchKey ? branchFile.content : null;

  useEffect(() => {
    if (!ownCr || !ownCrTouchesFile) return;
    let cancelled = false;
    readFileOnBranch(ownCr.branch, fileRepoPath)
      .then((content) => {
        if (!cancelled) setBranchFile({ key: branchKey, content });
      })
      .catch(() => {
        /* branch unreadable — fall back to the clean view rather than an error */
      });
    return () => {
      cancelled = true;
    };
  }, [ownCr, ownCrTouchesFile, fileRepoPath, branchKey]);

  const suggestionDiff: DiffLine[] | null = useMemo(() => {
    if (raw === null || branchRaw === null) return null;
    const d = diffLines(raw, branchRaw);
    return hasChanges(d) ? d : null;
  }, [raw, branchRaw]);

  const openInEditor = useCallback(
    (wsRelative: string) => navigate(kbFileUrl(DEFAULT_BRANCH, wsRelative)),
    [navigate],
  );

  const handleSuggest = useCallback(
    async (find: string, replace: string, note: string) => {
      if (!user) throw new Error('Sign in to suggest a change.');
      await suggestChange({
        skillName: name,
        repoRelativePath: fileRepoPath,
        find,
        replace,
        note: note || undefined,
        userEmail: user.email,
        userName: user.name,
        existingCr: ownCr,
      });
      toast('Suggestion saved to your draft');
      setBranchRevision((r) => r + 1);
      data.reload();
    },
    [user, name, fileRepoPath, ownCr, toast, data],
  );

  async function withdrawOwn() {
    if (!ownCr) return;
    try {
      await cancelPullRequest(ownCr.number);
      toast('Suggestion withdrawn');
      setBranchFile(null);
      data.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't withdraw the suggestion.");
    }
  }

  const backLink = (
    <Button variant="quiet" size="sm" onClick={() => navigate(LIBRARY_ROOT)}>
      ‹ All skills &amp; tools
    </Button>
  );

  if (detail.loading) {
    return <div className="py-16 text-center text-ui text-ink-muted">Loading…</div>;
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
        mainContent={(rel) => (rel === 'SKILL.md' ? skill.body : detail.fileContent(rel))}
        loadMainFile={(rel) => {
          if (rel !== 'SKILL.md') detail.loadFile(rel);
        }}
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
        {skill.description && (
          <p className="mt-1.5 max-w-[56ch] text-lede text-ink-muted">{skill.description}</p>
        )}
        {/* No `Manage access` here, deliberately — a skill inherits its group
            folder's `access.md`, and the group's Share panel is the one place
            those rules are decided. Same call the tool page made. */}
      </header>

      <IntegrationsSection needed={needed} onConnect={() => navigate('/connect')} />

      <SkillFileTabs
        files={files}
        selected={active}
        pending={pendingFiles}
        onSelect={setSelected}
      />

      <SkillFilePane
        file={active}
        raw={raw}
        suggestion={suggestionDiff}
        bodyRef={fileViewRef}
        onOpenLink={(href) => {
          if (!kbDirName) return;
          openInEditor(resolveRelativePath(`${kbDirName}/${skill.path}/${active}`, href));
        }}
        actions={
          owned && kbDirName ? (
            <Button
              variant="outline"
              size="tiny"
              onClick={() => openInEditor(`${kbDirName}/${skill.path}/${active}`)}
            >
              Edit
            </Button>
          ) : null
        }
        notice={
          suggestionDiff ? (
            <Banner tone="wait" role="status" className="mx-3.5 mt-3">
              <span className="flex flex-wrap items-center gap-3">
                Your pending suggestions are shown inline
                <Button variant="danger" size="tiny" onClick={() => void withdrawOwn()}>
                  Withdraw
                </Button>
              </span>
            </Banner>
          ) : null
        }
      />

      <SuggestChange containerRef={fileViewRef} raw={raw} onSubmit={handleSuggest} />

      {owned && <ChangeRequestDock crs={skillCrs} onSelect={setCompareCr} />}
    </Article>
  );
}

/** Does this change request touch anything inside the skill folder? */
function touchesSkill(cr: PullRequestSummary, skillPath: string): boolean {
  return cr.touchedNodePaths.some((p) => p === skillPath || p.startsWith(`${skillPath}/`));
}

/**
 * The reading column. Horizontal and vertical padding come from the Library
 * layout's `<main>`, which already wraps every page under `/skills-and-tools`.
 */
function Article({ children }: { children: ReactNode }) {
  return <article className="mx-auto w-full max-w-3xl pb-14">{children}</article>;
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
