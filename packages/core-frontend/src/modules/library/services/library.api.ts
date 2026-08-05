import { DEFAULT_BRANCH, type PullRequestSummary } from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';
import { createBranch } from '../../git/services/git.api';
import { getOrCreateWorkspace, readFile, writeFile } from '../../workspace/services/workspace.api';
import { openChangeRequest } from '../../pr/services/pr-open.api';
import { postPrComment } from '../../pr/services/pr-comments.api';

/**
 * Library data access. Skills come from the browser skill routes
 * (`GET /api/skills`, `GET /api/skills/:name[?file=…]`) — the same
 * default-branch, per-user-`canRead`-filtered catalog the agent sees.
 * Change requests come from the workflow routes the pr module already talks
 * to. Integration (tool) data is NOT here — the Library reuses
 * `secrets-vault/services/tool-secrets.api.ts` directly.
 */

/** The default-branch workspace id — derivable client-side (id = encodeURIComponent(branch)). */
export const DEFAULT_WORKSPACE_ID = encodeURIComponent(DEFAULT_BRANCH);

export interface LibrarySkillSummary {
  /** Canonical id = the skill's folder name (e.g. `rfi`). */
  name: string;
  description: string;
  version?: string;
  /** Repo-root-relative skill folder, e.g. `Groups/Everyone/rfi`. */
  path: string;
}

export interface LibrarySkill extends LibrarySkillSummary {
  /** The SKILL.md markdown body. */
  body: string;
  allowedTools?: string[];
  /** Repo-root-relative bundled file paths (SKILL.md itself is not listed). */
  files: string[];
}

interface SkillFilePayload {
  name: string;
  file: string;
  path: string;
  content: string;
}

type GetSkillPayload =
  | { ok: true; kind: 'skill'; skill: LibrarySkill }
  | { ok: true; kind: 'file'; file: SkillFilePayload }
  | { ok: false; error: 'not_found' | 'forbidden' | 'invalid_file' };

export async function listSkills(): Promise<LibrarySkillSummary[]> {
  const data = await handleApiResponse<{ skills: LibrarySkillSummary[] }>(
    await authFetch('/api/skills'),
  );
  return data.skills;
}

export async function getSkill(name: string): Promise<LibrarySkill> {
  const data = await handleApiResponse<GetSkillPayload>(
    await authFetch(`/api/skills/${encodeURIComponent(name)}`),
  );
  if (!data.ok || data.kind !== 'skill') throw new Error("Couldn't load this skill.");
  return data.skill;
}

/** Content of a bundled skill file. `file` is relative to the skill folder. */
export async function getSkillFile(name: string, file: string): Promise<string> {
  const data = await handleApiResponse<GetSkillPayload>(
    await authFetch(`/api/skills/${encodeURIComponent(name)}?file=${encodeURIComponent(file)}`),
  );
  if (!data.ok || data.kind !== 'file') throw new Error("Couldn't load this file.");
  return data.file.content;
}

/** All open change requests (the Library filters them to a skill's folder). */
export async function listOpenChangeRequests(): Promise<PullRequestSummary[]> {
  return handleApiResponse<PullRequestSummary[]>(
    await authFetch('/api/workflow/change-requests'),
  );
}

/** The caller's own change requests (any state; callers filter to open). */
export async function listMyChangeRequests(): Promise<PullRequestSummary[]> {
  return handleApiResponse<PullRequestSummary[]>(
    await authFetch('/api/workflow/change-requests/mine'),
  );
}

/** Read a file from a branch's shared workspace (bootstraps the clone if needed). */
export async function readFileOnBranch(branch: string, repoRelativePath: string): Promise<string> {
  const { workspace } = await getOrCreateWorkspace(branch);
  return readFile(workspace.id, `${workspace.kbDirName}/${repoRelativePath}`);
}

/**
 * Keep only characters git branch segments accept; collapse the rest to '-'.
 *
 * The two dot rules are not cosmetic — `assertValidBranchName` REJECTS the
 * whole branch over either, and the rejection surfaces as a 400 on "Propose
 * changes" with nothing on screen explaining why. They matter now that FILE
 * names reach this function (`suggestionBranchFor`), because file names are
 * where dots actually live: `..` anywhere in a ref is invalid, and a segment
 * ending `.lock` is how git names its own lockfiles, so a skill shipping a
 * `deps.lock` beside its SKILL.md would otherwise be unproposable.
 */
function branchSegment(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+/, '')
    .replace(/[.]+$/, '')
    .replace(/\.lock$/, '-lock');
  return cleaned || 'user';
}

/** Git's own ceiling on a ref name; a longer one is refused outright. */
const MAX_BRANCH_LENGTH = 255;

/**
 * A 32-bit FNV-1a digest of the file path, as fixed-width hex.
 *
 * What matters is WHAT it hashes: the raw path, before `branchSegment` has
 * touched it. `branchSegment` is lossy by design — every character git will
 * not take becomes '-', so `reference/DESIGN-SYSTEM.md` and
 * `reference-design-system.md` come out of it as the same slug. Two files
 * sharing one branch is not a cosmetic clash: `SkillPage` decides which
 * request belongs to the open file BY BRANCH, so the first file's pending
 * request is handed to the second as its own, the editor stays closed, and a
 * proposal on the second file is written into the first file's request
 * instead of opening its own.
 *
 * Not a cryptographic hash and does not need to be — it separates the files
 * within one skill folder, and 32 bits is orders of magnitude more than the
 * dozens of paths that live there.
 */
function pathDigest(raw: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    // ×16777619 (the FNV prime) written as shifts, so it stays in 32 bits.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Drop separators a truncation may have left dangling on the end. */
const trimEnd = (s: string): string => s.replace(/[-./]+$/, '');

/**
 * The one suggestion branch per user per skill FILE (see mocks/README.md —
 * suggestions are git). The file lands FLATTENED into the last segment
 * (`--<slug>`) rather than nested under the skill (`/<slug>`): skill-level
 * branches from before files were part of the name (`suggestions/u/skill`)
 * linger after a merge or cancel, and git refuses to create
 * `suggestions/u/skill/anything` while one exists — the ref would have to be
 * a file and a directory at once.
 *
 * The file segment is a readable slug plus a digest of the path it came from.
 * The slug alone cannot identify the file — it is lossy (see `pathDigest`) —
 * and it is unbounded, while the ref it lands in is capped at 255. So the
 * digest carries the identity and the slug is free to be truncated to
 * whatever room the base leaves, staying human-readable without being load
 * bearing.
 *
 * Without `file` this returns the legacy skill-level name, byte for byte as
 * before — callers still need it in order to RECOGNISE requests opened before
 * branches carried the file, and those branches already exist under that
 * exact name.
 */
export function suggestionBranchFor(userEmail: string, skillName: string, file?: string): string {
  const base = `suggestions/${branchSegment(userEmail.split('@')[0])}/${branchSegment(skillName)}`;
  if (file === undefined) return base;

  const fileDigest = pathDigest(file);
  // The `--` joiner and the `-<digest>` are the parts that cannot be dropped;
  // whatever the cap leaves after them is the slug's to use.
  const fileCost = 2 + fileDigest.length + 1;

  // A base long enough to crowd out the digest is pathological (a ~240-char
  // skill name), but truncating it beats emitting a ref git will reject — and
  // truncation loses the base's identity exactly as flattening loses the
  // file's, so it earns a digest on the same reasoning: two skills alike for
  // their first 235 characters would otherwise share one branch, and a shared
  // branch is a shared change request. The digest is over the RAW inputs, not
  // over `base`, so it survives BOTH lossy steps — `branchSegment` has already
  // mapped every character git refuses onto '-' by the time `base` exists, so
  // skills differing only in punctuation are indistinguishable there too.
  const baseTruncated = base.length + fileCost > MAX_BRANCH_LENGTH;
  const baseSuffix = baseTruncated ? `-${pathDigest(`${userEmail} ${skillName}`)}` : '';
  const fixedCost = fileCost + baseSuffix.length;

  const head = baseTruncated
    ? trimEnd(base.slice(0, MAX_BRANCH_LENGTH - fixedCost))
    : base;
  const slug = trimEnd(branchSegment(file).slice(0, MAX_BRANCH_LENGTH - head.length - fixedCost));

  return slug
    ? `${head}--${slug}-${fileDigest}${baseSuffix}`
    : `${head}--${fileDigest}${baseSuffix}`;
}

export interface ProposeChangeInput {
  skillName: string;
  /** Repo-root-relative path of the file being proposed on. */
  repoRelativePath: string;
  /** The same file relative to the skill folder (e.g. `SKILL.md`) — names the branch. */
  file: string;
  /** The file's full new text — what the author typed in the editor. */
  content: string;
  /** Optional "why" — lands in the change-request description / a comment. */
  note?: string;
  userEmail: string;
  userName: string;
  /** The caller's open change request for this file, if any. */
  existingCr?: PullRequestSummary | null;
}

/**
 * Propose a change: commit the new text to the author's suggestion branch for
 * this file (`suggestions/<user>/<skill>--<file>`, forked from the default
 * branch) and make sure an open change request against the default branch
 * exists for it.
 *
 * Save = share: `writeFile` on the branch workspace auto-commits and pushes, so
 * the proposal is durable the moment this resolves — there is no local-only
 * state that could be lost between here and the owner reading it.
 *
 * One branch and one change request PER PERSON PER FILE: proposing on a second
 * file of the same skill opens a second request rather than growing the first,
 * so a pending proposal never locks the rest of the skill, and each file's
 * change is approved or declined on its own. The title names the file for the
 * same reason — the owner's dock can now hold several requests from the same
 * person on the same skill.
 */
export async function proposeChange(input: ProposeChangeInput): Promise<{ branch: string }> {
  const branch =
    input.existingCr?.branch ??
    suggestionBranchFor(input.userEmail, input.skillName, input.file);

  if (!input.existingCr) {
    try {
      await createBranch(DEFAULT_WORKSPACE_ID, branch, DEFAULT_BRANCH);
    } catch {
      // Branch may already exist from an earlier (merged/cancelled) round —
      // reuse it; the change request below is what makes it reviewable again.
    }
  }

  const { workspace } = await getOrCreateWorkspace(branch);
  await writeFile(
    workspace.id,
    `${workspace.kbDirName}/${input.repoRelativePath}`,
    input.content,
  );

  if (input.existingCr) {
    if (input.note) {
      await postPrComment(input.existingCr.number, { body: input.note });
    }
  } else {
    await openChangeRequest({
      sourceBranch: branch,
      targetBranch: DEFAULT_BRANCH,
      title: `Changes from ${input.userName} — ${input.skillName} · ${input.file}`,
      description: input.note || undefined,
    });
  }
  return { branch };
}
