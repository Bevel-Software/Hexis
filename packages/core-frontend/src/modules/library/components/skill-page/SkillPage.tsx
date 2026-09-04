import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, History } from 'lucide-react';
import {
  DEFAULT_BRANCH,
  pluginOfPath,
  type PullRequestSummary,
} from '@bevel-software/platform-shared';
import '../../library.css';
import {
  Badge,
  Button,
  IconButton,
  MenuItem,
  MenuPanel,
  Surface,
  useDismissableMenu,
} from '../../../../shared/components';
import { useAuth } from '../../../auth/state/auth.context';
import { useWorkspace } from '../../../workspace/state/workspace.context';
import { useGit } from '../../../git/state/git.context';
import { FileHistoryPanel } from '../../../git/components/FileHistoryPanel';
import { kbFileUrl, resolveRelativePath, useNodeIdNav } from '../../../workspace/routing/kb-routes';
import { cancelPullRequest } from '../../../pr/services/pr-cancel.api';
import { useFileAccess } from '../../../access/hooks/useFileAccess';
import { proposeChange, suggestionBranchFor } from '../../services/library.api';
import { getOrCreateWorkspace, writeFile } from '../../../workspace/services/workspace.api';
import { useSkillDetail } from '../../hooks/useSkillDetail';
import { useApplyChangeRequest } from '../../../change-requests/hooks/useApplyChangeRequest';
import { useCrFileDiffs } from '../../../change-requests/hooks/useCrFileDiffs';
import { useDefaultBranchFile, useFileOnBranch } from '../../../change-requests/hooks/useFileOnBranch';
import { useLibrary } from '../../state/library-data';
import { useLibraryToast } from '../../state/toast.context';
import { libraryHomeForItemPath, urlForSkillFile } from '../../routes/library-paths';
import { changeAuthorName, formatWhen } from '../../../change-requests/utils/author';
import { ownersTextOf } from '../../utils/plugin-summary';
import { neededToolsFor, toolStatus } from '../../utils/status';
import { StatusDot } from '../StatusDot';
import { SharedViaPlugins } from './SharedViaPlugins';
import { AccessRequestsBanner } from '../AccessRequestsBanner';
import { useJoinRequests, type JoinRequestsApi } from '../../hooks/useJoinRequests';
import { listSkillAccessRequests, reconcileSkillAccessRequest } from '../../services/library.api';
import { ManageAccessDialog } from '../../../access/components/ManageAccessDialog';
import { ChangeRequestDock } from '../ChangeRequestDock';
import { ChangeRequestDialog } from '../../../change-requests/components/ChangeRequestDialog';
import { SkillFileTabs } from './SkillFileTabs';
import { skillPanelId, skillTabId } from './tab-ids';
import { SkillFilePane } from './SkillFilePane';
import { SkillFileEditor } from './SkillFileEditor';
import { ChangeBox } from '../../../change-requests/components/ChangeBox';
import { conflictResolutionPrompt } from '../../../change-requests/utils/conflict';
import { isBinaryFile } from '../../../workspace/components/renderers';

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
export function SkillPage({
  name: nameProp,
  activeFile,
  provisional = false,
}: {
  /**
   * Both provided when the page is mounted at its CANONICAL address — the
   * skill file's own /workspace URL (see `WorkspaceItemGate`): `name` names
   * the skill, `activeFile` the tab, and switching tabs NAVIGATES (each file
   * has its own URL). Absent on the legacy `/skills-and-tools/skills/:name`
   * mount, where the name comes from the route and tabs are local state.
   */
  name?: string;
  activeFile?: string;
  /**
   * Whether `name` is a GUESS the catalog never confirmed — read off the URL's
   * folder name, which is the skill's id only when no frontmatter declares
   * one. A failed lookup for a provisional name is not evidence of absence
   * until the catalog has actually answered; it may simply be the wrong name.
   * Default `false`: a caller that says nothing is naming a skill it knows.
   */
  provisional?: boolean;
} = {}) {
  const { name: rawName = '' } = useParams<{ name: string }>();
  const name = nameProp ?? safeDecode(rawName);
  const navigate = useNavigate();
  const toast = useLibraryToast();
  const { kbDirName } = useWorkspace();
  const { user } = useAuth();
  const data = useLibrary();
  const detail = useSkillDetail(name);
  // The same id-link resolver the Knowledge renderer uses — a `[text](node-id)`
  // link inside a skill file navigates to that node, not to a dead span.
  const { openNodeId } = useNodeIdNav();

  const [selectedState, setSelected] = useState('SKILL.md');
  const selected = activeFile ?? selectedState;
  const [compareCr, setCompareCr] = useState<PullRequestSummary | null>(null);
  /**
   * The `⋯` menu's one destination: the git log for the file on screen,
   * rendered in place of the reading pane. Local state rather than a URL,
   * matching the Knowledge viewer's `activeTab` — a skill's canonical address
   * names the FILE, and history is a lens on it, not a different file.
   *
   * Cleared whenever the file changes; see `historyKey` for why that is not a
   * matter of taste.
   */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const menuRef = useDismissableMenu<HTMLDivElement>({
    open: menuOpen,
    onClose: closeMenu,
    returnFocusTo: menuTriggerRef,
  });
  /** Ties the tabs to the panel they control; unique per mounted page. */
  const tabsId = useId();
  const git = useGit();

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

  /** Every plugin holding this skill, from the catalog's decoration. */
  const memberships = useMemo(
    () => data.items.find((i) => i.kind === 'skill' && i.id === name)?.plugins ?? [],
    [data.items, name],
  );
  /**
   * Write-access requests on this skill, for its editors. The endpoint answers
   * `[]` to everyone else, so the fetch is unconditional and the banner hides
   * itself; `owned` only spares a pointless call.
   */
  const skillRequestsApi = useMemo<JoinRequestsApi>(
    () => ({ list: listSkillAccessRequests, reconcile: reconcileSkillAccessRequest }),
    [],
  );
  const accessRequests = useJoinRequests(name, skillPath || null, skillRequestsApi);
  const [manageOpen, setManageOpen] = useState(false);

  /**
   * Who has to say yes. A skill has no owner of its own — it inherits its plugin
   * folder's `access.md` — so the people who review a change to it are the
   * plugin's owners. Naming the wrong reviewer is worse than naming none, hence
   * the neutral fallback when the plugin index hasn't resolved.
   */
  const ownerName = useMemo(() => {
    const plugin = skill ? pluginOfPath(skill.path) : null;
    const summary = plugin ? data.pluginSummaries.find((g) => g.name === plugin) : undefined;
    return summary ? ownersTextOf(summary) : 'the owner';
  }, [skill, data.pluginSummaries]);

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

  /**
   * May the caller WRITE this file — the real per-file ACL answer, resolved
   * against the default branch (where skills live), not a guess from the
   * catalog's `owned` flag. This is what decides which button the file bar
   * carries: `Edit` for a hard-or-optimistic yes (null = lookup in flight,
   * same rule as the Knowledge viewer), `Propose changes` for a hard no.
   */
  const fileAccess = useFileAccess(
    kbDirName && skillPath ? `${kbDirName}/${fileRepoPath}` : null,
    DEFAULT_BRANCH,
  );

  /** Bumped after every write so the branch reads re-run against fresh content. */
  const [revision, setRevision] = useState(0);
  /**
   * Creation hands off straight into the editor: `NewSkillPanel` navigates
   * here with `startEditing` in the router state, so the person who just made
   * an empty skill lands with the cursor in it instead of on an empty page.
   */
  const location = useLocation();
  const [editing, setEditing] = useState(
    Boolean((location.state as { startEditing?: boolean } | null)?.startEditing),
  );
  const [busyCr, setBusyCr] = useState<number | null>(null);

  /**
   * The workspace-relative path `FileHistoryPanel` reads the git log for — the
   * same string the Knowledge viewer hands it, so a skill file's history is
   * the file's history, not a second implementation of it. Null until the
   * workspace and the skill have both resolved: the panel takes a path and
   * asks immediately, so handing it a half-built one would ask about
   * `undefined/SKILL.md`.
   */
  const historyPath = kbDirName && skillPath ? `${kbDirName}/${fileRepoPath}` : null;
  /**
   * Whether `⋯` has anything behind it. Git not ready means there is no log to
   * show, and an overflow that opens onto an empty panel is worse than no
   * overflow at all — the same call `KbPageHeader` makes.
   *
   * `!editing` is the other half, and it is not cosmetic: `SkillFileEditor`
   * holds the draft in its own state, so swapping it out for the history panel
   * would throw away whatever the person had typed with no warning and no way
   * back. The menu returns the moment they save or cancel.
   */
  const historyAvailable = git.availability === 'ready' && historyPath !== null && !editing;
  /**
   * History closes when the file changes. It is a lens on ONE file, so a tab
   * switch must land on that file's CONTENT — and it must stay landed: keying
   * the open flag to the file it was opened for is not enough, because coming
   * back to that tab then re-opens the log nobody asked for a second time.
   *
   * Adjusted during render rather than in an effect, so the new file's content
   * paints on the first frame. An effect would show the old file's log under
   * the new file's heading for one commit, which is the flicker the `active`
   * derivation a few lines up exists to avoid.
   */
  const [historyKey, setHistoryKey] = useState(fileRepoPath);
  if (historyKey !== fileRepoPath) {
    setHistoryKey(fileRepoPath);
    if (historyOpen) setHistoryOpen(false);
  }
  // Losing the log CLOSES it, rather than parking it behind a flag. Git
  // availability is re-derived from a polled status call, so a single failed
  // poll flips it to `error` — which takes the panel off screen — and the next
  // successful one flips it back. Left open, that second poll would put the
  // log back over the file minutes after the reader returned to reading. Once
  // it is gone they ask for it again, which is one click.
  //
  // BOTH flags, for one reason: the trigger and its panel live behind
  // `historyAvailable` together, so an open menu unmounts with them and its
  // flag is left set behind an element nobody can see. Closing only the log
  // fixed the panel and left the menu to spring open by itself on the next
  // good poll.
  //
  // `editing` is the second door into the same state, and it is reachable
  // without a mouse: `useDismissableMenu` dismisses on outside POINTERDOWN, so
  // tabbing from the open menu to Edit and pressing Enter never dismisses it.
  // The editor then withdraws `historyAvailable`, and Cancel used to hand the
  // menu back open.
  if (historyOpen && !historyAvailable) setHistoryOpen(false);
  if (menuOpen && !historyAvailable) setMenuOpen(false);
  const viewingHistory = historyAvailable && historyOpen;
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
      toast('Approved: the skill now reads with that change.');
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
        toast('Blocked: the file changed after this was written.', 'danger');
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
   * The editor's BASE — the text the proposal is typed over and diffed
   * against. With no open request of your own it is the default branch's
   * file; with one, it is the file as it reads on YOUR suggestions branch,
   * fetched only once the editor opens. That branch read is what makes a
   * second round of edits INCREMENTAL: it stacks on what you already
   * proposed instead of silently starting over from the published text and
   * overwriting your own pending change.
   *
   * Resolved through `ownCr` (recognised by BRANCH — see above) so the
   * submit path reuses the existing request; a proposal on top of a request
   * the page failed to recognise would open a second one against the same
   * branch.
   */
  const canEditDirectly = fileAccess.canWrite === true;
  const ownBranchBase = useFileOnBranch(
    editing && !canEditDirectly && ownCr ? ownCr.branch : null,
    skillPath ? fileRepoPath : null,
    revision,
  );
  // A direct edit always bases on the default branch — the file as everyone
  // reads it. Only the propose flow stacks on the caller's own branch copy.
  const editorBase = !canEditDirectly && ownCr ? ownBranchBase : rawOnMain;

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

  /**
   * The writer's submit: straight onto the default branch. One `writeFile` is
   * a complete save — the route acquires the file lock (where the ACL gate
   * runs), writes, and releases into the commit queue — so this is the same
   * save the Knowledge editor performs, minus the app switch.
   */
  async function saveDirect(content: string) {
    const { workspace } = await getOrCreateWorkspace(DEFAULT_BRANCH);
    await writeFile(workspace.id, `${workspace.kbDirName}/${fileRepoPath}`, content);
    setEditing(false);
    setRevision((r) => r + 1);
    toast('Saved: the skill now reads with your change.');
    data.reload();
  }

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
    toast(`Sent to ${ownerName}: nothing changes until they approve it.`);
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

  // The page the skill lives on, not the Library root: "back" from a skill
  // you opened off its plugin page must land on that plugin page. Derived from
  // the path, so a deep link gets the same honest destination as a click.
  const home = libraryHomeForItemPath(skillPath);
  const backLink = (
    <Button variant="quiet" size="sm" onClick={() => navigate(home.path)}>
      {`‹ ${home.label}`}
    </Button>
  );

  // "Doesn't exist" is a VERDICT, and a provisional name has not earned one:
  // the route guessed it from the URL's folder name, so a failed lookup may
  // just mean we asked with the wrong name. Only the catalog can correct that,
  // and only a SUCCESSFUL catalog response counts — `loading: false` also
  // describes a catalog that failed, which is "we couldn't ask", not "there is
  // no such skill". The same distinction PluginPage draws a few files over.
  //
  // A confirmed name (the catalog resolved this URL to it) is unaffected: its
  // detail error is real and gets reported immediately.
  const catalogAnswered = !data.loading && !data.error;
  const mayConcludeAbsence = !provisional || catalogAnswered;
  if (!detail.loading && mayConcludeAbsence && (detail.error || !skill)) {
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


  // The change-request dialog is a full-screen surface, not a layer over this
  // page — rendering both would leave the page's dock and tabs live
  // underneath it. It is the SHARED dialog, scoped to this skill: its folder
  // frames the file list, and the skill's own files always show so an owner
  // can read the untouched parts too.
  if (compareCr && skill) {
    return (
      <ChangeRequestDialog
        cr={compareCr}
        scope={{ prefix: skill.path, baseFiles: files }}
        onClose={() => setCompareCr(null)}
        onResolved={() => {
          toast('Change request is being applied');
          setCompareCr(null);
          data.reload();
        }}
      />
    );
  }

  // Loading deliberately falls through to this real page tree. The route
  // already knows the skill name, `files` already contains SKILL.md, and
  // keeping these exact nodes mounted prevents a blank handoff followed by a
  // second layout when the detail request settles.
  return (
    <Article>
      {backLink}

      <header className="mt-4">
        <div className="flex items-center gap-3">
          <h1 className="min-w-0 text-display font-semibold text-ink">{skill?.name ?? name}</h1>
          {skill && owned && (
            <Badge tone="outline" size="xs" className="shrink-0 uppercase">
              Owner
            </Badge>
          )}

          {/* The same overflow a Knowledge page carries, for the same reason:
              a skill is a file in the repository, and "who changed this, when"
              is answerable about it exactly as it is about any other file. It
              was unanswerable HERE and nowhere else, because this page is the
              only surface a `Plugins/` file has — the shell routes those URLs
              to the Library (`isLibraryLocation`) and the Knowledge tree does
              not list `Plugins/` at all, so there was no viewer to fall back
              to and no row to right-click.

              Version history is the whole menu, so the trigger goes where the
              menu goes — see `historyAvailable`. */}
          {historyAvailable && (
            <div className="relative ml-auto flex-none">
              <IconButton
                ref={menuTriggerRef}
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                active={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <span aria-hidden className="text-strong leading-none">
                  ⋯
                </span>
              </IconButton>
              {menuOpen && (
                <div ref={menuRef} className="absolute right-0 top-[calc(100%+5px)] z-40">
                  <MenuPanel role="menu" aria-label="More actions" className="min-w-[212px]">
                    <MenuItem
                      role="menuitem"
                      onClick={() => {
                        closeMenu();
                        setHistoryOpen(true);
                      }}
                    >
                      <span className="flex items-center gap-2.5">
                        <History size={14} />
                        Version history
                      </span>
                    </MenuItem>
                  </MenuPanel>
                </div>
              )}
            </div>
          )}
        </div>
        {/* No description line here — the file pane renders the raw SKILL.md,
            and its frontmatter panel already says what the skill is for.
            Repeating it above the pane said the same sentence twice on the
            first screenful. */}
        {/* No `Manage access` here, deliberately — a skill inherits its plugin
            folder's `access.md`, and the plugin's Share panel is the one place
            those rules are decided. Same call the tool page made. */}
      </header>

      {owned && (
        <AccessRequestsBanner
          plugin={name}
          folders={[skillPath]}
          requests={accessRequests.requests}
          onManage={() => setManageOpen(true)}
          onAccept={(r, p) => void accessRequests.accept(r, p)}
          onDecline={(r) => void accessRequests.decline(r)}
        />
      )}
      {manageOpen && kbDirName && skillPath && (
        <ManageAccessDialog
          entry={{ name, relativePath: `${kbDirName}/${skillPath}`, type: 'directory' }}
          onClose={() => {
            setManageOpen(false);
            accessRequests.reload();
            data.reload();
          }}
        />
      )}

      <IntegrationsSection needed={needed} onConnect={() => navigate('/connect')} />

      {skill && (
        <SharedViaPlugins
          skillName={name}
          skillPath={skillPath}
          memberships={memberships}
          owned={owned}
          onChanged={() => {
            data.reload();
            data.reloadPlugins();
          }}
        />
      )}

      <SkillFileTabs
        files={files}
        selected={active}
        pending={pendingFiles}
        baseId={tabsId}
        onSelect={(f) => {
          // At the canonical mount every file has its own URL — a tab switch
          // is a navigation, so the address bar always names what is on
          // screen and any tab can be deep-linked or shared.
          if (activeFile !== undefined && skill && kbDirName) {
            navigate(urlForSkillFile(kbDirName, skill.path, f));
          } else {
            setSelected(f);
          }
          setEditing(false);
        }}
      />

      {/* The panel the tabs control. It wraps the reading pane, the editor
          that replaces it and the history that replaces both, so
          `aria-controls` resolves in every state rather than pointing at an
          element that exists only some of the time. */}
      <div
        role="tabpanel"
        id={skillPanelId(tabsId)}
        aria-labelledby={skillTabId(tabsId, active)}
        aria-busy={(!viewingHistory && (detail.loading || raw === null)) || undefined}
      >
      {viewingHistory && historyPath !== null ? (
        <>
          {/* An explicit way back. Without it the only route to the file would
              be reopening it, since history is not in the URL. */}
          <div className="mb-3 mt-4 flex items-center gap-2">
            <Button
              variant="quiet"
              size="sm"
              leadingIcon={<ArrowLeft size={13} />}
              onClick={() => setHistoryOpen(false)}
            >
              Back to the file
            </Button>
            <span className="text-detail text-ink-faint">{`Version history: ${active}`}</span>
          </div>
          {/* A DEFINITE height, and a flex column to hold it. The panel is
              built for the Knowledge viewer's full-height pane: its list and
              its diff both scroll inside themselves, which needs a parent
              whose height does not come from them. Dropped straight into this
              reading column it would size to its own content instead, so a
              long diff would stretch the page rather than scroll in place and
              the empty state would collapse to a line. The measure matches the
              editor's textarea, which is the same trade in the same column. */}
          <Surface
            radius="lg"
            className="flex h-[60vh] min-h-80 flex-col overflow-hidden"
          >
            <FileHistoryPanel filePath={historyPath} />
          </Surface>
        </>
      ) : detail.loading ? (
        <SkillFilePane
          file={active}
          raw={null}
          suggestion={null}
          headingLink={headingLink}
        />
      ) : editing && editorBase !== null && fileAccess.canWrite !== null ? (
        <SkillFileEditor
          file={active}
          base={editorBase}
          mode={canEditDirectly ? 'edit' : 'propose'}
          owner={ownerName}
          onCancel={() => setEditing(false)}
          onSubmit={canEditDirectly ? saveDirect : submitProposal}
        />
      ) : (
        <SkillFilePane
          file={active}
          raw={raw}
          suggestion={null}
          onOpenLink={(href) => {
            if (!kbDirName) return;
            openInEditor(resolveRelativePath(`${kbDirName}/${skillPath}/${active}`, href));
          }}
          onOpenNodeId={openNodeId}
          headingLink={headingLink}
          /*
           * ONE action, decided by the ACL. An `Edit` used to sit beside
           * `Propose changes` for EVERYONE and jump to the Knowledge editor —
           * where, for anyone without a write grant, it ended in AccessDenied
           * after they had navigated away and typed the change. The trap was
           * never the button; it was offering it to people it would refuse.
           * So the file bar asks the per-file access resolver and shows
           * exactly one of the two — and BOTH now open the same editor in
           * place, right over the rendered file. What differs is what
           * submitting does: a writer's Save lands on the default branch, a
           * proposal lands on the author's suggestion branch as a change
           * request. Edit used to leave for the Knowledge app; being bounced
           * to a different surface to change the file you are reading was
           * the last piece of that old trap.
           *
           * One open proposal per person per SKILL, still — but proposing
           * again while yours is open is not refused anymore: it opens the
           * editor over the file AS YOU PROPOSED IT (see `editorBase`), and
           * submitting updates the same change request. Incremental, never a
           * fork, never a silent restart from the published text.
           */
          actions={
            // Only a RESOLVED verdict earns a button: `null` (lookup in
            // flight) briefly shows no action rather than an Edit that might
            // open the wrong mode — a writer's text must never ride the
            // proposal path just because they clicked before the ACL answered.
            fileAccess.canWrite === true
              ? rawOnMain !== null && (
                  <Button
                    variant="outline"
                    size="tiny"
                    onClick={() => setEditing(true)}
                    title="Edit this file in place"
                  >
                    Edit
                  </Button>
                )
              : fileAccess.canWrite === false && rawOnMain !== null && (
                  <Button
                    variant="outline"
                    size="tiny"
                    onClick={() => setEditing(true)}
                    title={
                      ownCr
                        ? 'Continue your open proposal. Edits update the same change request'
                        : "You can't edit this file directly. Propose a change for its owners to approve"
                    }
                  >
                    Propose changes
                  </Button>
                )
          }
        />
      )}

      {/* Every open proposal on this file, under the file it is about. The
          owner decides here; the author can take theirs back. Not under the
          history panel: a box asking "approve this?" needs the text it would
          change above it, and the log is not that text. The dock below still
          reaches every open request from either view. */}
      {!editing &&
        !viewingHistory &&
        boxes.map((cr) => {
          const mine = data.myCrNumbers.has(cr.number);
          // `[]` is the hook's "overtaken" answer — the proposal and the file
          // now say the same thing — and is distinct from `null`, which only
          // means a side has not arrived yet.
          const fileDiff = crDiffs.get(cr.number) ?? null;
          return (
            <ChangeBox
              key={cr.number}
              file={active}
              author={changeAuthorName(cr)}
              when={formatWhen(cr.createdAt)}
              mine={mine}
              canDecide={owned && !mine}
              diff={fileDiff}
              binary={isBinaryFile(active)}
              upToDate={fileDiff !== null && fileDiff.length === 0}
              blocked={blockedCrs.has(cr.number)}
              conflictPrompt={conflictResolutionPrompt(cr)}
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
      {skill && owned && <ChangeRequestDock crs={skillCrs} onSelect={setCompareCr} />}
    </Article>
  );
}

/** Does this change request touch anything inside the skill folder? */
function touchesSkill(cr: PullRequestSummary, skillPath: string): boolean {
  return cr.touchedNodePaths.some((p) => p === skillPath || p.startsWith(`${skillPath}/`));
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
                  {/* `status.text`, never a hardcoded "Connected": this list is
                      built from what is stored, and nothing here has probed
                      anything — so it says "Key saved"/"Signed in" and keeps the
                      reassurance that no action is needed. */}
                  {status.state === 'ok' ? `${status.text}. Nothing to do` : status.text}
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
