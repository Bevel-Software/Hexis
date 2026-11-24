/**
 * A commit's files as `git ls-tree -r -z <commit>` prints them: one record
 * per file, `<mode> <type> <object id>\t<path>`, a NUL after each. With `-l`
 * a record also carries the object's size, `<object id> <size>\t<path>`;
 * git then reads every object's header, so a commit with a lost object
 * cannot be listed that way.
 *
 * The object id is what makes a listing more than names: two commits that
 * list the same id at a path hold the same bytes there, so what was read
 * from one need not be read from the other.
 */

const NUL = 0x00;
const TAB = 0x09;
const SPACE = 0x20;

/** One file of a listing, beside its path. */
export interface ListedFile {
  /**
   * True for an ordinary file (git modes 100644 and 100755). False for a
   * symbolic link or a submodule: what the checkout holds at such a path is
   * not what the object holds, so nothing may be decided about it from the
   * commit.
   */
  readonly regular: boolean;
  /**
   * True for a folder's own record, which a listing made with `-t` carries
   * beside the files (an empty folder object included, which has no file to
   * show it by).
   */
  readonly folder: boolean;
  /** The object's size in bytes; 0 for an entry that is not a regular file, and in a listing without sizes. */
  readonly size: number;
  /** The object id, decoded only when asked: a listing names tens of thousands of files and a caller wants the id of a few. */
  objectId(): string;
}

/**
 * Call `visit` for every file of a listing, in the order git printed them.
 *
 * `path` is decoded from the bytes on its own, so it is a string of its own
 * and keeps nothing else alive.
 *
 * A record that is not in the shape above throws: a caller deciding access
 * from a listing it could not read whole would be deciding from a part of it.
 */
export function visitTreeListing(bytes: Buffer, visit: (path: string, file: ListedFile) => void): void {
  let off = 0;
  while (off < bytes.length) {
    const end = bytes.indexOf(NUL, off);
    // Git ends every record with a NUL: output that stops without one was
    // cut short, and the records after the cut are not here to be missed.
    if (end < 0) throw new Error('git ls-tree output ends inside a record');
    if (end > off) {
      const tab = bytes.indexOf(TAB, off);
      const modeEnd = bytes.indexOf(SPACE, off);
      const typeEnd = modeEnd < 0 ? -1 : bytes.indexOf(SPACE, modeEnd + 1);
      if (tab < 0 || tab >= end || tab + 1 >= end || typeEnd < 0 || typeEnd >= tab) {
        throw new Error('unexpected git ls-tree record');
      }
      // The id ends at the size when the listing has one (`-l`), else at the tab.
      const space = bytes.indexOf(SPACE, typeEnd + 1);
      const idEnd = space >= 0 && space < tab ? space : tab;
      if (idEnd === typeEnd + 1) throw new Error('unexpected git ls-tree record');
      const mode = bytes.toString('latin1', off, modeEnd);
      const regular = mode === '100644' || mode === '100755';
      const folder = mode === '040000';
      const sizeText = idEnd < tab ? bytes.toString('latin1', idEnd + 1, tab).trim() : '';
      const size = regular && sizeText !== '' ? Number(sizeText) : 0;
      if (!Number.isInteger(size) || size < 0) throw new Error('unexpected git ls-tree record');
      const idStart = typeEnd + 1;
      visit(bytes.toString('utf8', tab + 1, end), {
        regular,
        folder,
        size,
        objectId: () => bytes.toString('latin1', idStart, idEnd),
      });
    }
    off = end + 1;
  }
}
