import { GROUPS_DIR, LEGACY_SKILLS_DIR, LEGACY_TOOLS_DIR } from '@bevel-software/platform-shared';

/** A physical KB folder backing a logical group, and which root it sits under. */
export interface GroupFolder {
  /** Repo-relative folder, e.g. `Groups/GTM` or `Skills/GTM`. */
  folder: string;
  root: 'Groups' | 'Skills' | 'Tools';
}

/** The roots whose direct subfolders are groups, in the order cards render. */
const ROOTS: { dir: string; root: GroupFolder['root'] }[] = [
  { dir: GROUPS_DIR, root: 'Groups' },
  { dir: LEGACY_SKILLS_DIR, root: 'Skills' },
  { dir: LEGACY_TOOLS_DIR, root: 'Tools' },
];

/**
 * The physical folders a logical group is made of, derived from the paths of
 * the items in it.
 *
 * A group is a folder — but mid-migration it can be TWO or THREE of them
 * (`Skills/GTM` and `Tools/GTM` before the merge into `Groups/GTM`), and each
 * carries its OWN `access.md`. The access surface has to say so rather than
 * pick one and imply it governs the rest, so this returns every folder it can
 * prove exists from the catalog instead of guessing at a canonical one.
 *
 * Derived from item paths rather than from a constant precisely so nothing here
 * depends on the migration state: whatever the KB actually looks like today is
 * what renders. The rule mirrors `groupOfPath` exactly — root segment is a group
 * root, second segment is the group, and there must be something below it.
 *
 * Ordering is Groups, then Skills, then Tools — the destination first, so a
 * mid-migration group reads as "here is the new home, and here is what has not
 * moved yet". Deduped; an empty or all-ungrouped input yields `[]`.
 */
export function groupFoldersFor(group: string, itemPaths: string[]): GroupFolder[] {
  const seen = new Set<string>();
  for (const path of itemPaths) {
    const segments = path.split('/').filter(Boolean);
    // `Tools/slack.tool` is two segments — a tool in no group at all. Requiring
    // a third segment is what keeps it out, exactly as `groupOfPath` does.
    if (segments.length < 3) continue;
    if (segments[1] !== group) continue;
    if (!ROOTS.some((r) => r.dir === segments[0])) continue;
    seen.add(`${segments[0]}/${segments[1]}`);
  }

  return ROOTS.filter((r) => seen.has(`${r.dir}/${group}`)).map((r) => ({
    folder: `${r.dir}/${group}`,
    root: r.root,
  }));
}
