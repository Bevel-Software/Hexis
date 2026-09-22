/**
 * The contract of the READ-BEFORE-WRITE gate: nothing is created, changed or
 * removed at a place its author cannot read. The service that answers
 * (filesystem stats, access checks) is `modules/access/change-read-gate.ts`;
 * this file carries only the types, so the workflow, kb-fs and tool modules
 * depend on the contract and never on the access module.
 *
 * Why `read`, when every write already needs `write`: on a draft branch no
 * write grant is needed at all — anyone may propose anything, and the change
 * request is where the real boundary lives. Without this gate a proposal
 * could land in a folder its author cannot see, where it would vanish from
 * them the moment it was added. And a write grant only IMPLIES read; a
 * nearer `deny read` can take the read away while the write stands. The gate
 * makes the one rule hold everywhere: you can only change what you can see.
 *
 * The one exception is a NEW FOLDER directly under one of the three roots
 * (knowledge, skills, plugins — `creatableRootDirNames`). Those roots grant
 * read to nobody by default, and a person's own space or a new plugin or
 * skill has to start somewhere. The new folder carries its creator's own
 * grant in its `access.md` (see `ICreatorAccess`), so what they create there
 * is visible to them from the first byte. A loose FILE directly at a root
 * cannot carry such a grant, so it is not excepted.
 */

/**
 * Where a change is asked about. `'file'` is what every lock acquire is (the
 * path being written, moved, or deleted — a `.gitkeep` included); `'dir'` is
 * for a caller asking about a folder itself before it fills it, such as the
 * destination of an archive extraction.
 */
export type ChangeTargetKind = 'file' | 'dir';

export type ChangeReadVerdict =
  | {
      allowed: true;
      via:
        /** The caller reads the path (or, for a new path, where it lands). */
        | 'readable'
        /** A new folder directly under one of the three roots — the exception. */
        | 'new-top-level-folder'
        /** Outside the knowledge-base repository: no read rules apply. */
        | 'outside-kb'
        /** A machine-owned file whose writer the write rule already names. */
        | 'machine-owned'
        /** An admin on a file directly in the repository root — the rescue path. */
        | 'admin-rescue'
        /**
         * No `roles.yaml` on this tree at all — a repository before its first
         * one: nothing to decide against. A `roles.yaml` that is THERE but
         * unusable is not this: a broken rule set is an error, never an open
         * door.
         */
        | 'no-rules';
    }
  | {
      allowed: false;
      /**
       * The repo-relative path the caller cannot read: the target itself when
       * it exists, otherwise the folder it would land in (`''` = the root).
       */
      unreadable: string;
    };

export interface IChangeReadGate {
  /** The verdict for `wsPath` (workspace-relative), with why it holds. */
  judge(
    workspaceId: string,
    userEmail: string,
    wsPath: string,
    kind: ChangeTargetKind,
  ): Promise<ChangeReadVerdict>;

  /** `judge`, throwing `AccessDeniedError` (with `unreadable` set) on a refusal. */
  assertMayChange(
    workspaceId: string,
    userEmail: string,
    wsPath: string,
    kind: ChangeTargetKind,
  ): Promise<void>;
}
