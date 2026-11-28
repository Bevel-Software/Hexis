/**
 * THE sentence a move answers with when its destination lies inside what is
 * being moved: `Team` to `Team/Twin/Team`. No filesystem can do that move, and
 * the raw `rename` error it fails with names a path on the server's disk.
 *
 * The agent's `move_file` (its dry run and the move) and the app's rename and
 * drag all answer with {@link moveIntoItselfSentence}, so the refusal reads the
 * same everywhere. Whether a destination IS inside is decided by the server
 * against its filesystem (the same name in another case is the same folder on
 * one volume and another folder on the next); {@link moveIntoItselfRefusal} is
 * the decision on the paths alone, for the app's drag, whose paths come from
 * the tree as they are spelled on disk.
 */
export function moveIntoItselfSentence(src: string, dest: string): string {
  const shownSrc = segmentsOf(src).join('/');
  return `Nothing can be moved into itself: "${segmentsOf(dest).join('/')}" is inside "${shownSrc}". Choose a destination outside "${shownSrc}".`;
}

/**
 * The sentence when `dest`, as spelled, is inside `src`; null otherwise.
 *
 * Judged segment by segment, never by string prefix: `Team2` is not inside
 * `Team`. Trailing slashes, `.` segments and empty segments are spelling, not
 * names, and are ignored. `..` and backslashes are not resolved: `..` is
 * compared as a name, which no folder is called, and never makes a path
 * inside. Case is compared exactly; another case of the same name is a
 * question for the filesystem, not for the strings.
 *
 * Answers null when the destination is not inside the source, the source
 * itself included (a move onto itself is refused elsewhere, as a no-op).
 */
export function moveIntoItselfRefusal(src: string, dest: string): string | null {
  const from = segmentsOf(src);
  const to = segmentsOf(dest);
  if (from.length === 0 || to.length <= from.length) return null;
  if (!from.every((segment, i) => segment === to[i])) return null;
  return moveIntoItselfSentence(src, dest);
}

function segmentsOf(p: string): string[] {
  return p.split('/').filter((segment) => segment !== '' && segment !== '.');
}
