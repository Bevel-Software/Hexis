/**
 * A commit's files as `git ls-tree -r -z <commit>` prints them: one record
 * per file, `<mode> <type> <object id>\t<path>`, a NUL after each.
 *
 * The object id is what makes a listing more than names: two commits that
 * list the same id at a path hold the same bytes there, so what was read
 * from one need not be read from the other.
 */

const NUL = 0x00;
const TAB = 0x09;
const SPACE = 0x20;

/**
 * Call `visit` for every file of a listing, in the order git printed them.
 *
 * `path` is decoded from the bytes on its own, so it is a string of its own
 * and keeps nothing else alive (see `parseNulListing`). `objectId` decodes
 * the id only when called: a listing names tens of thousands of files and a
 * caller wants the id of a few.
 *
 * A record that is not in the shape above throws: a caller deciding access
 * from a listing it could not read whole would be deciding from a part of it.
 */
export function visitTreeListing(
  bytes: Buffer,
  visit: (path: string, objectId: () => string) => void,
): void {
  let off = 0;
  while (off < bytes.length) {
    let end = bytes.indexOf(NUL, off);
    if (end < 0) end = bytes.length;
    if (end > off) {
      const tab = bytes.indexOf(TAB, off);
      const idStart = tab < 0 || tab >= end ? -1 : bytes.lastIndexOf(SPACE, tab - 1) + 1;
      if (idStart <= off || tab + 1 >= end) {
        throw new Error('unexpected git ls-tree record');
      }
      visit(bytes.toString('utf8', tab + 1, end), () => bytes.toString('latin1', idStart, tab));
    }
    off = end + 1;
  }
}
