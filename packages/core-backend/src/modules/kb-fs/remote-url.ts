/**
 * Whether two repository addresses name the same repository.
 *
 * The answer decides whether a working copy on disk is KEPT or DELETED, so it
 * errs towards "same": only differences that cannot change which repository
 * is meant are ignored, and they are ignored on both sides.
 *
 *  - a trailing slash, and a `.git` suffix — hosts serve both spellings;
 *  - the letter case of the scheme and the host — DNS does not distinguish;
 *  - userinfo (`user:token@`) — who asks does not change what is asked for,
 *    and a credential must never decide, or appear in, a comparison.
 *
 * The PATH keeps its case: hosts that fold it and hosts that do not both
 * exist, and treating `Org/Repo` and `org/repo` as one would keep a clone of
 * the wrong repository on a host that tells them apart — but deleting a clone
 * of the right one is the worse error, and an operator who only changed the
 * case gets a re-clone, not a loss: the work on that clone was pushed to the
 * same place.
 */
export function normalizeRepositoryAddress(address: string): string {
  let a = address.trim();
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(a);
  if (url) {
    const host = url[2]!.replace(/^[^@]*@/, '').toLowerCase();
    a = `${url[1]!.toLowerCase()}://${host}${url[3] ?? ''}`;
  }
  return a
    .replace(/[\\/]+$/, '')
    .replace(/\.git$/i, '')
    .replace(/[\\/]+$/, '');
}

export function sameRepository(a: string, b: string): boolean {
  return normalizeRepositoryAddress(a) === normalizeRepositoryAddress(b);
}
