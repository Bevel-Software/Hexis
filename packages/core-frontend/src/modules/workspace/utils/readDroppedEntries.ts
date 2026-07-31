// Streaming walker for HTML5 drag-and-drop folder uploads.
//
// `DataTransfer.files` returns a flat FileList — when the user drops a folder,
// folder entries appear as bogus zero-byte File objects, NOT as a recursive
// listing of the folder's contents. To preserve folder structure we have to
// walk `DataTransfer.items` via `webkitGetAsEntry()`, which exposes the
// FileSystem API (FileSystemFileEntry / FileSystemDirectoryEntry). The name is
// prefixed for historical reasons; the API is supported across all current
// evergreen browsers.
//
// Yielded as an async generator so the upload pipeline can start sending the
// first file before the rest of the tree has been enumerated — for deep or
// large folders the walk itself can take hundreds of ms.
//
// IMPORTANT: callers must snapshot `webkitGetAsEntry()` for each item
// synchronously inside the drop handler before any `await`, because the
// browser invalidates the `DataTransfer` once the drop handler returns.
// `walkEntries` accepts the snapshot array; `walkDroppedItems` is a
// convenience that takes a live `DataTransferItemList` and must itself only
// be called synchronously from within the drop handler.

export type DroppedItem =
  | { kind: 'file'; file: File; relativePath: string }
  | { kind: 'dir'; relativePath: string };

/**
 * OS-generated noise that should never make it into a KB. Mirrors the
 * filter the backend's `/unzip` route already applies in
 * `workspace.service.ts`, so behavior is consistent across "drop a folder"
 * and "upload + extract a zip."
 *
 * - `__MACOSX/`, plain `__MACOSX` — Apple archive metadata directory.
 * - `.DS_Store` at any depth — Finder folder-state cache.
 * - `._<anything>` at any depth — macOS resource-fork sidecar files.
 */
export function isUploadNoise(relativePath: string): boolean {
  return (
    relativePath.startsWith('__MACOSX/')
    || relativePath === '__MACOSX'
    || relativePath.endsWith('/.DS_Store')
    || relativePath === '.DS_Store'
    || /(^|\/)\._/.test(relativePath)
  );
}

/**
 * Snapshot the entries from a `DataTransferItemList` synchronously. Must be
 * called from inside the drop handler before the first `await`.
 */
export function snapshotEntries(items: DataTransferItemList): FileSystemEntry[] {
  const out: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Walk a pre-snapshotted array of FileSystemEntry, yielding files and
 * directories in tree order (each directory yielded before its children).
 *
 * Errors on individual entries (broken aliases, permission denials) are
 * logged and skipped — the rest of the walk continues so a single bad file
 * doesn't abort the whole drop.
 */
export async function* walkEntries(entries: FileSystemEntry[]): AsyncGenerator<DroppedItem> {
  for (const entry of entries) {
    yield* walkEntry(entry, '');
  }
}

async function* walkEntry(entry: FileSystemEntry, prefix: string): AsyncGenerator<DroppedItem> {
  const name = entry.name;
  const relativePath = prefix ? `${prefix}/${name}` : name;
  if (entry.isFile) {
    try {
      const file = await fileEntryAsFile(entry as FileSystemFileEntry);
      yield { kind: 'file', file, relativePath };
    } catch (err) {
      console.warn(`[upload] skipping file entry "${relativePath}":`, err);
    }
    return;
  }
  if (entry.isDirectory) {
    yield { kind: 'dir', relativePath };
    try {
      for await (const child of readDirectoryEntries(entry as FileSystemDirectoryEntry)) {
        yield* walkEntry(child, relativePath);
      }
    } catch (err) {
      console.warn(`[upload] failed to read directory "${relativePath}":`, err);
    }
  }
}

function fileEntryAsFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

// `readEntries` yields children in batches of ~100 — must be called repeatedly
// until it returns an empty array, otherwise large directories silently
// truncate.
async function* readDirectoryEntries(
  dir: FileSystemDirectoryEntry,
): AsyncGenerator<FileSystemEntry> {
  const reader = dir.createReader();
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) return;
    for (const e of batch) yield e;
  }
}
