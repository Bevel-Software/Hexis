import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DEFAULT_BRANCH,
  type FileTreeEntry,
  type PullRequestSummary,
} from '@bevel-software/platform-shared';
import { Dialog } from '../../../shared/components/Dialog';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useAuth } from '../../auth/state/auth.context';
import { kbFileUrl, resolveRelativePath } from '../../workspace/routing/kb-routes';
import { KbMarkdownView } from '../../workspace/components/renderers/KbMarkdownView';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { cancelPullRequest } from '../../pr/services/pr-cancel.api';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import { readFileOnBranch, suggestChange, type LibrarySkillSummary } from '../services/library.api';
import { useSkillDetail } from '../hooks/useSkillDetail';
import { useLibraryToast } from '../state/toast';
import {
  neededToolsFor,
  toolStatus,
  toolVariableStatuses,
} from '../utils/status';
import { diffLines, hasChanges, type DiffLine } from '../utils/diff';
import { StatusGem } from './StatusGem';
import { ChangeRequestDock } from './ChangeRequestDock';
import { CompareView } from './CompareView';
import { SuggestChange } from './SuggestChange';

export type DetailTarget =
  | { kind: 'skill'; skill: LibrarySkillSummary; owned: boolean }
  | { kind: 'integration'; tool: ToolSecrets };

export interface DetailDialogProps {
  target: DetailTarget;
  tools: ToolSecrets[];
  skills: LibrarySkillSummary[];
  allowedToolsBySkill: Map<string, string[]>;
  /** Open change requests (all authors). */
  crs: PullRequestSummary[];
  /** Numbers of the caller's own change requests. */
  myCrNumbers: Set<number>;
  inLoadout: boolean;
  onToggleLoadout(): void;
  onClose(): void;
  /** Something durable changed (merge, send back, withdraw, new suggestion). */
  onDataChanged(): void;
}

/** Does this change request touch anything inside the skill folder? */
function touchesSkill(cr: PullRequestSummary, skillPath: string): boolean {
  return cr.touchedNodePaths.some((p) => p === skillPath || p.startsWith(`${skillPath}/`));
}

const OWNER_TAG = (
  <span className="rounded-full border border-[#f0dda6] bg-[#fdf3d8] px-1.5 text-[9.5px] font-bold tracking-[.05em] text-[#92600a]">
    OWNER
  </span>
);

/**
 * The ⓘ detail dialog from the approved mock, on the shared Dialog primitive
 * (Esc / backdrop close come with it). Skills: description, needed
 * integrations with per-connection state + Connect, clickable file browser
 * (SKILL.md tagged MAIN), owner-only Manage access + Edit, the change-request
 * layer (owner dock → side-by-side compare; own pending suggestions inline
 * with withdraw; select-text → suggest). Integrations: per-connection status
 * rows and the skills that use it.
 */
export function DetailDialog(props: DetailDialogProps) {
  const { target, inLoadout, onToggleLoadout, onClose } = props;
  const name = target.kind === 'skill' ? target.skill.name : target.tool.name;
  const owned = target.kind === 'skill' ? target.owned : target.tool.canWrite;
  const [compareCr, setCompareCr] = useState<PullRequestSummary | null>(null);

  const loadoutButton = (
    <button
      type="button"
      className={
        inLoadout
          ? 'rounded-[10px] border border-[#f5c2c2] bg-[#fdecec] px-3.5 py-1.5 text-xs font-bold text-[#c53030]'
          : 'rounded-[10px] bg-gradient-to-br from-[#0d9488] to-[#0f766e] px-3.5 py-1.5 text-xs font-bold text-white shadow-[0_4px_14px_rgba(13,148,136,0.22)]'
      }
      onClick={onToggleLoadout}
    >
      {inLoadout ? 'In loadout — remove' : '+ Add to loadout'}
    </button>
  );

  return (
    <>
      <div className={compareCr ? 'hidden' : undefined}>
        <Dialog
          open
          onClose={onClose}
          size="2xl"
          title={
            <span className="flex items-center gap-2 text-[15px]">
              {name}
              {owned && OWNER_TAG}
              <span className="text-[10.5px] font-normal uppercase tracking-[.08em] text-ink-faint">
                {target.kind === 'skill' ? 'Skill' : 'Integration'}
              </span>
            </span>
          }
          headerActions={loadoutButton}
          bodyClassName="min-h-[16rem]"
        >
          {target.kind === 'skill' ? (
            <SkillDetailBody {...props} skillSummary={target.skill} owned={target.owned} onCompare={setCompareCr} />
          ) : (
            <ToolDetailBody {...props} tool={target.tool} />
          )}
        </Dialog>
      </div>
      {target.kind === 'skill' && compareCr && (
        <SkillCompareHost
          {...props}
          skillSummary={target.skill}
          cr={compareCr}
          onExit={() => setCompareCr(null)}
        />
      )}
    </>
  );
}

/* ── skill body ── */

interface SkillBodyProps extends DetailDialogProps {
  skillSummary: LibrarySkillSummary;
  owned: boolean;
  onCompare(cr: PullRequestSummary): void;
}

function SkillDetailBody({
  skillSummary,
  owned,
  tools,
  crs,
  myCrNumbers,
  onCompare,
  onDataChanged,
}: SkillBodyProps) {
  const navigate = useNavigate();
  const toast = useLibraryToast();
  const { kbDirName } = useWorkspace();
  const { user } = useAuth();
  const detail = useSkillDetail(skillSummary.name);
  const [selected, setSelected] = useState('SKILL.md');
  const [accessOpen, setAccessOpen] = useState(false);
  const fileViewRef = useRef<HTMLDivElement>(null);

  const prefix = `${skillSummary.path}/`;
  const relFiles = useMemo(
    () => ['SKILL.md', ...(detail.skill?.files ?? []).map((f) => f.slice(prefix.length))],
    [detail.skill, prefix],
  );

  useEffect(() => {
    if (selected !== 'SKILL.md') detail.loadFile(selected);
    // detail.loadFile is stable enough per (name, contents); keep deps minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, detail.skill]);

  const raw = selected === 'SKILL.md' ? (detail.skill?.body ?? null) : detail.fileContent(selected);

  const needed = useMemo(
    () => (detail.skill ? neededToolsFor(detail.skill, tools) : []),
    [detail.skill, tools],
  );

  const skillCrs = useMemo(
    () => crs.filter((c) => touchesSkill(c, skillSummary.path)),
    [crs, skillSummary.path],
  );
  const ownCr = useMemo(
    () => skillCrs.find((c) => myCrNumbers.has(c.number)) ?? null,
    [skillCrs, myCrNumbers],
  );

  // Own pending suggestions render inline: diff main → own suggestion branch.
  const [branchRaw, setBranchRaw] = useState<string | null>(null);
  const [branchRevision, setBranchRevision] = useState(0);
  const fileRepoPath = `${skillSummary.path}/${selected}`;
  const ownCrTouchesFile = ownCr !== null && ownCr.touchedNodePaths.includes(fileRepoPath);
  useEffect(() => {
    setBranchRaw(null);
    if (!ownCr || !ownCrTouchesFile) return;
    let cancelled = false;
    readFileOnBranch(ownCr.branch, fileRepoPath)
      .then((content) => {
        if (!cancelled) setBranchRaw(content);
      })
      .catch(() => {
        /* branch unreadable — fall back to the clean main view */
      });
    return () => {
      cancelled = true;
    };
  }, [ownCr, ownCrTouchesFile, fileRepoPath, branchRevision]);

  const suggestionDiff: DiffLine[] | null = useMemo(() => {
    if (raw === null || branchRaw === null) return null;
    const d = diffLines(raw, branchRaw);
    return hasChanges(d) ? d : null;
  }, [raw, branchRaw]);

  const openInEditor = useCallback(
    (wsRelative: string) => {
      navigate(kbFileUrl(DEFAULT_BRANCH, wsRelative));
    },
    [navigate],
  );

  const handleSuggest = useCallback(
    async (find: string, replace: string, note: string) => {
      if (!user) throw new Error('Sign in to suggest a change.');
      await suggestChange({
        skillName: skillSummary.name,
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
      onDataChanged();
    },
    [user, skillSummary.name, fileRepoPath, ownCr, toast, onDataChanged],
  );

  async function withdrawOwn() {
    if (!ownCr) return;
    try {
      await cancelPullRequest(ownCr.number);
      toast('Suggestion withdrawn');
      setBranchRaw(null);
      onDataChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't withdraw the suggestion.");
    }
  }

  if (detail.loading) {
    return <div className="py-8 text-center text-sm text-ink-faint">Loading…</div>;
  }
  if (detail.error || !detail.skill) {
    return <div className="py-8 text-center text-sm text-[#c53030]">{detail.error ?? "Couldn't load this skill."}</div>;
  }

  const accessEntry: FileTreeEntry | null = kbDirName
    ? { name: 'SKILL.md', relativePath: `${kbDirName}/${skillSummary.path}/SKILL.md`, type: 'file' }
    : null;

  return (
    <div className="text-sm">
      <p className="mb-4 text-[13.5px] text-ink-muted">{detail.skill.description}</p>

      <section className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[10.5px] font-bold uppercase tracking-[.09em] text-ink-faint">
            Integrations this skill needs
          </h4>
          {owned && accessEntry && (
            <button
              type="button"
              className="rounded-lg bg-[#eef2f7] px-3.5 py-1 text-[11.5px] font-bold text-ink-muted shadow-[inset_0_0_0_1px_#d3dbe6] transition-transform hover:-translate-y-px"
              onClick={() => setAccessOpen(true)}
            >
              Manage access
            </button>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          {needed.length === 0 ? (
            <IntItem
              title="Knowledge base only"
              sub="No external connections needed"
              right={<StatusGem state="ok" />}
            />
          ) : (
            needed.map((t) => {
              const status = toolStatus(t);
              return (
                <IntItem
                  key={t.slug}
                  title={t.name}
                  sub={status.state === 'ok' ? 'Connected — nothing to do' : status.text}
                  right={
                    status.state === 'ok' ? (
                      <StatusGem state="ok" />
                    ) : (
                      <ConnectButton
                        label={status.state === 'err' ? 'Reconnect' : 'Connect'}
                        onClick={() => navigate('/connect')}
                      />
                    )
                  }
                />
              );
            })
          )}
        </div>
      </section>

      <section className="mb-4">
        <h4 className="mb-2 text-[10.5px] font-bold uppercase tracking-[.09em] text-ink-faint">
          Files in this skill — click one to view it
        </h4>
        <div className="flex flex-col gap-1.5">
          {relFiles.map((rel) => (
            <button
              key={rel}
              type="button"
              className={`flex items-center gap-2 rounded-[9px] border px-2.5 py-1.5 text-left transition-colors ${
                selected === rel
                  ? 'border-[#0d9488] bg-[#e6f7f4]'
                  : 'border-line bg-[#fafbfd] hover:border-[#7fd0c4]'
              }`}
              onClick={() => setSelected(rel)}
            >
              <span
                className={`font-mono text-[11.5px] font-semibold ${selected === rel ? 'text-[#0f766e]' : 'text-ink-muted'}`}
              >
                {rel}
              </span>
              {rel === 'SKILL.md' && (
                <span className="rounded-full bg-white px-1.5 text-[9.5px] font-bold tracking-[.04em] text-[#0f766e] shadow-[inset_0_0_0_1px_#d2e9e4]">
                  MAIN
                </span>
              )}
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="font-mono text-[11px] text-ink-muted">{selected}</h4>
          {owned && kbDirName && (
            <button
              type="button"
              className="rounded-lg bg-[#e0f8ee] px-3.5 py-1 text-[11.5px] font-bold text-[#0a8f60] shadow-[inset_0_0_0_1px_#a9e8cd] transition-transform hover:-translate-y-px"
              onClick={() => openInEditor(`${kbDirName}/${skillSummary.path}/${selected}`)}
            >
              Edit
            </button>
          )}
        </div>

        {suggestionDiff && (
          <div className="mb-2 flex items-center justify-between rounded-lg border border-[#d2e9e4] bg-[#e6f7f4] px-3 py-1.5 text-[11.5px] text-[#0f766e]">
            <span>Your pending suggestions are shown inline</span>
            <button
              type="button"
              className="rounded-full bg-[#fdecec] px-3 py-0.5 font-bold text-[#c53030] shadow-[inset_0_0_0_1px_#f3c4c4]"
              onClick={() => void withdrawOwn()}
            >
              Withdraw
            </button>
          </div>
        )}

        <div ref={fileViewRef}>
          {raw === null ? (
            <div className="py-4 text-center text-xs text-ink-faint">Loading…</div>
          ) : suggestionDiff ? (
            <pre className="lib-sug whitespace-pre-wrap break-words rounded-[13px] border border-line bg-[#f7f9fb] p-3.5 font-mono text-[11.5px] leading-relaxed text-ink-muted">
              {suggestionDiff.map((l, i) =>
                l.kind === 'same' ? (
                  <div key={i}>{l.text || ' '}</div>
                ) : l.kind === 'removed' ? (
                  <del key={i} className="block">
                    {l.text || ' '}
                  </del>
                ) : (
                  <ins key={i} className="block">
                    {l.text || ' '}
                  </ins>
                ),
              )}
            </pre>
          ) : selected.endsWith('.md') ? (
            <div className="rounded-[13px] border border-line bg-[#f7f9fb] px-4 py-3">
              <KbMarkdownView
                source={raw}
                onOpenFile={(href) => {
                  if (!kbDirName) return;
                  openInEditor(resolveRelativePath(`${kbDirName}/${skillSummary.path}/${selected}`, href));
                }}
              />
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-[13px] border border-line bg-[#f7f9fb] p-3.5 font-mono text-[11.5px] leading-relaxed text-ink-muted">
              {raw}
            </pre>
          )}
        </div>
      </section>

      <SuggestChange containerRef={fileViewRef} raw={raw} onSubmit={handleSuggest} />

      {owned && <ChangeRequestDock crs={skillCrs} onSelect={onCompare} />}

      {accessOpen && accessEntry && (
        <ManageAccessDialog entry={accessEntry} onClose={() => setAccessOpen(false)} />
      )}
    </div>
  );
}

/* ── compare host: mounts the split view once the skill detail is available ── */

interface CompareHostProps extends DetailDialogProps {
  skillSummary: LibrarySkillSummary;
  cr: PullRequestSummary;
  onExit(): void;
}

function SkillCompareHost({ skillSummary, cr, onExit, onDataChanged }: CompareHostProps) {
  const toast = useLibraryToast();
  const detail = useSkillDetail(skillSummary.name);

  if (detail.loading) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim text-sm text-white">
        Loading…
      </div>
    );
  }
  if (!detail.skill) return null;

  return (
    <CompareView
      skill={detail.skill}
      mainContent={(rel) => (rel === 'SKILL.md' ? detail.skill!.body : detail.fileContent(rel))}
      loadMainFile={(rel) => {
        if (rel !== 'SKILL.md') detail.loadFile(rel);
      }}
      cr={cr}
      onClose={onExit}
      onResolved={(kind) => {
        toast(kind === 'applied' ? 'Change request is being applied' : 'Sent back to the author');
        onExit();
        onDataChanged();
      }}
    />
  );
}

/* ── integration body ── */

interface ToolBodyProps extends DetailDialogProps {
  tool: ToolSecrets;
}

function ToolDetailBody({ tool, skills, allowedToolsBySkill }: ToolBodyProps) {
  const navigate = useNavigate();
  const { kbDirName } = useWorkspace();
  const rows = toolVariableStatuses(tool);

  const usedBy = useMemo(
    () =>
      skills.filter(
        (s) =>
          neededToolsFor({ allowedTools: allowedToolsBySkill.get(s.name) }, [tool]).length > 0,
      ),
    [skills, allowedToolsBySkill, tool],
  );

  return (
    <div className="text-sm">
      <section className="mb-4">
        <h4 className="mb-2 text-[10.5px] font-bold uppercase tracking-[.09em] text-ink-faint">
          Connection status
        </h4>
        <div className="flex flex-col gap-1.5">
          {rows.length === 0 ? (
            <IntItem title="Nothing to set up" sub="This integration works for everyone as-is" right={<StatusGem state="ok" />} />
          ) : (
            rows.map(({ v, status }) => (
              <IntItem
                key={v.name}
                title={v.label ?? v.name}
                sub={
                  status.state === 'ok'
                    ? v.scope === 'admin'
                      ? 'Set up for the whole team'
                      : 'Connected'
                    : status.text
                }
                right={
                  status.state === 'ok' ? (
                    <StatusGem state="ok" />
                  ) : v.scope === 'user' && v.adminConfigured !== false ? (
                    <ConnectButton
                      label={status.state === 'err' ? 'Reconnect' : 'Connect'}
                      onClick={() => navigate('/connect')}
                    />
                  ) : tool.canWrite && kbDirName ? (
                    <ConnectButton
                      label="Set up"
                      onClick={() => navigate(kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/${tool.path}`))}
                    />
                  ) : (
                    <StatusGem state={status.state} />
                  )
                }
              />
            ))
          )}
        </div>
      </section>

      <section>
        <h4 className="mb-2 text-[10.5px] font-bold uppercase tracking-[.09em] text-ink-faint">
          Used by these skills
        </h4>
        {usedBy.length === 0 ? (
          <span className="text-[11.5px] italic text-ink-faint">No skills use this yet</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {usedBy.map((s) => (
              <span
                key={s.name}
                className="rounded-full border border-line bg-white px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted"
              >
                {s.name}
              </span>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ── small shared rows ── */

function IntItem({ title, sub, right }: { title: string; sub: string; right: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-[11px] border border-line bg-[#fafbfd] px-3 py-2">
      <div className="min-w-0">
        <b className="block text-[12.5px] text-ink">{title}</b>
        <small className="block text-[11px] text-ink-faint">{sub}</small>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>
    </div>
  );
}

function ConnectButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button
      type="button"
      className="rounded-lg bg-gradient-to-br from-[#f59e0b] to-[#d97706] px-3 py-1.5 text-[11.5px] font-bold text-white shadow-[0_2px_10px_rgba(245,158,11,0.35)] transition-transform hover:-translate-y-px"
      onClick={onClick}
    >
      {label} →
    </button>
  );
}
