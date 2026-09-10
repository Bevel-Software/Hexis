import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { DEFAULT_BRANCH, PLUGINS_DIR, PLUGIN_MANIFEST_FILE, type FileTreeEntry } from '@bevel-software/platform-shared';
import { cn } from '../../../lib/utils';
import { Button } from '../../../shared/components';
import { listFiles, readFile } from '../../workspace/services/workspace.api';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { findKbRoot } from '../../workspace/utils/fileTree';
import { kbFileUrl } from '../../workspace/routing/kb-routes';

/**
 * The plugin page's two smallest sections, both pure REUSE of the Knowledge
 * file viewer: links are `kbFileUrl` + `rawFile` navigations into the same
 * raw editor the tool page's "Edit the tool file" uses — rendered inside
 * this app by `WorkspaceItemRoute`; no new viewer, no new backend. The one
 * exception is a `.tool` file in a namespace listing, which drops the
 * `rawFile` state so the item route renders its library tool page — the
 * same destination its card in the Tools band reaches.
 *
 * MANIFEST: writers get a button to `plugin.json`. It is a button to the FILE,
 * not a form, deliberately: the fields worth hand-editing (`version`,
 * `description`, `license`) are plain JSON, and the `extensions` block is
 * machine-written by the server editor — a bespoke form would either duplicate
 * that editor or invite hand-edits it then overwrites.
 *
 * EXTENSIONS: the spec reserves reverse-DNS directories for client-specific
 * data any other client must ignore — which cuts both ways: a plugin authored
 * for ANOTHER client can carry `com.example.client/`, and this section is how
 * a person inspects one instead of wondering what it is. Our own namespace's
 * `tools/` contents already appear in the Tools band above, so entries here
 * are typically foreign — exactly when looking inside matters.
 */

/** A reverse-DNS namespace directory: at least one dot, per the spec's shape. */
const isNamespaceDir = (name: string): boolean => name.includes('.');

export function ManifestButton({
  kbDirName,
  folder,
  canWrite,
}: {
  kbDirName: string | null;
  folder: string;
  canWrite: boolean;
}) {
  const navigate = useNavigate();
  if (!canWrite || !kbDirName) return null;
  return (
    <Button
      variant="quiet"
      size="sm"
      onClick={() =>
        navigate(kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/${PLUGINS_DIR}/${folder}/plugin.json`), {
          state: { rawFile: true },
        })
      }
    >
      Manifest
    </Button>
  );
}

/** The bundle dialect's manifest — read-only here; the file is edited in its own repository. */
const BUNDLE_MANIFEST_FILE = 'plugin.bundle.json';

/**
 * The manifest's CONTENTS, at the bottom of the plugin page, behind a
 * disclosure: closed, it is one line naming the file; open, it is the file —
 * what the plugin declares (its identifier, version, the skills it links,
 * the servers it declares) shown as the JSON it is, pretty-printed when it
 * parses and verbatim when it does not. Read only when opened, so a page
 * view costs no request for a section most visits never expand. A writer
 * gets the way to the raw editor from here too.
 */
export function ManifestSection({
  kbDirName,
  folder,
  managed,
  canWrite,
}: {
  kbDirName: string | null;
  folder: string;
  /** A native manifest (`plugin.json`); false for the bundle dialect's file. */
  managed: boolean;
  canWrite: boolean;
}) {
  const workspaceId = encodeURIComponent(DEFAULT_BRANCH);
  const navigate = useNavigate();
  const panelId = useId();
  const file = managed ? PLUGIN_MANIFEST_FILE : BUNDLE_MANIFEST_FILE;
  const path = kbDirName ? `${kbDirName}/${PLUGINS_DIR}/${folder}/${file}` : null;
  const [open, setOpen] = useState(false);
  // What was read, KEYED BY THE PATH it was read from: a folder change shows
  // nothing of the previous plugin's file while the new read is in flight,
  // with no reset to write — a result for another path is simply not this one.
  const [loaded, setLoaded] = useState<{ path: string; text: string | null; failed: boolean } | null>(null);
  const current = loaded?.path === path ? loaded : null;

  useEffect(() => {
    if (!open || path === null) return;
    let live = true;
    readFile(workspaceId, path)
      .then((text) => {
        if (live) setLoaded({ path, text, failed: false });
      })
      .catch(() => {
        if (live) setLoaded({ path, text: null, failed: true });
      });
    return () => {
      live = false;
    };
  }, [open, workspaceId, path]);

  if (path === null) return null;

  return (
    <section className="mt-8">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex items-center gap-[7px] text-label font-semibold uppercase text-ink-faint transition-colors hover:text-ink"
      >
        <span className="flex w-3 flex-none items-center justify-center">
          <ChevronRight size={11} className={cn('transition-transform duration-150', open && 'rotate-90')} />
        </span>
        Manifest
        <span className="font-mono normal-case tracking-normal text-ink-faint">{file}</span>
      </button>
      {open && (
        <div id={panelId} className="mt-2.5">
          <p className="mb-2 max-w-[62ch] text-detail text-ink-muted">
            What the plugin declares: its identifier and version, the skills it links and the
            servers it names.{' '}
            {managed
              ? 'The extensions block is written by the platform; the rest is yours to edit.'
              : 'Read from the bundle format; it is edited in its own repository.'}
          </p>
          {current?.failed ? (
            <p className="text-detail text-ink-muted">Couldn't read {file}.</p>
          ) : current?.text == null ? (
            <p className="text-detail text-ink-faint">Loading…</p>
          ) : (
            <pre className="overflow-x-auto rounded-md border border-line bg-sunken px-3.5 py-2.5 font-mono text-detail text-ink">
              {prettyJson(current.text)}
            </pre>
          )}
          {canWrite && managed && (
            <Button
              variant="quiet"
              size="sm"
              className="mt-2"
              onClick={() => navigate(kbFileUrl(DEFAULT_BRANCH, path), { state: { rawFile: true } })}
            >
              Edit the manifest
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** The file as JSON, laid out — or as written, when it is not JSON. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

interface NamespaceListing {
  namespace: string;
  files: string[]; // plugin-relative, e.g. `com.example.client/hooks/on-save.js`
}

export function ClientExtensionsSection({
  kbDirName,
  folder,
}: {
  kbDirName: string | null;
  folder: string;
}) {
  // LISTING and LINKS must agree on a branch. The links are pinned to the
  // default branch (plugins are default-branch content), so the tree read is
  // too — the context's workspace may sit on a draft branch, and a listing
  // from there would render files these links then cannot open. Workspace id
  // IS the encoded branch, by the platform's own contract.
  const workspaceId = encodeURIComponent(DEFAULT_BRANCH);
  const navigate = useNavigate();
  const { workspaceId: contextWorkspaceId, fileTree: contextTree } = useWorkspace();
  const [listings, setListings] = useState<NamespaceListing[]>([]);

  // The workspace context has usually ALREADY loaded this exact tree — it
  // bootstraps on the default branch — so the common case must not pay a
  // second full-tree round-trip per page view. The fetch survives only for
  // the case the reuse cannot cover: a context sitting on a draft branch,
  // whose tree could list files these default-branch links cannot open.
  // The reused tree is as stale as the context's — which is the freshness
  // the file explorer beside this page renders from, deliberately: one
  // section refetching on its own would show files the tree next to it
  // doesn't, and the context refresh cycle is where staleness is fixed.
  const reusableTree = contextWorkspaceId === workspaceId ? contextTree : null;

  useEffect(() => {
    // Reset FIRST: on a folder change or a failed refetch, stale state would
    // keep rendering the previous plugin's files under the new plugin's name.
    setListings([]);
    if (!kbDirName) return;
    if (reusableTree) {
      setListings(namespaceListings(reusableTree, folder));
      return;
    }
    let live = true;
    listFiles(workspaceId)
      .then((tree) => {
        if (live) setListings(namespaceListings(tree, folder));
      })
      .catch(() => {
        /* the section renders nothing — a tree fetch failure is not this page's story */
      });
    return () => {
      live = false;
    };
  }, [workspaceId, kbDirName, folder, reusableTree]);

  if (listings.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-2.5 text-label font-semibold uppercase text-ink-faint">
        Client-specific extensions
      </h2>
      <p className="mb-2 max-w-[62ch] text-detail text-ink-muted">
        Reverse-DNS directories carry data for a specific client; other clients ignore them. Files
        open in the Knowledge editor; a .tool opens its tool page.
      </p>
      {listings.map((l) => (
        <div key={l.namespace} className="mb-2 rounded-md border border-line px-3.5 py-2.5">
          <p className="font-mono text-detail font-semibold text-ink">{l.namespace}/</p>
          <ul className="mt-1">
            {l.files.map((f) => (
              <li key={f}>
                <button
                  type="button"
                  className="cursor-pointer font-mono text-detail text-ink-muted hover:text-ink hover:underline"
                  onClick={() =>
                    // `rawFile` steps past the app gate into the Knowledge
                    // editor — right for opaque client data (hooks, configs),
                    // wrong for a `.tool`: that file has a first-class tool
                    // page, and the same URL without the state renders it
                    // here in the library, exactly like its card above.
                    navigate(
                      kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/${PLUGINS_DIR}/${folder}/${f}`),
                      f.toLowerCase().endsWith('.tool') ? undefined : { state: { rawFile: true } },
                    )
                  }
                >
                  {f.slice(l.namespace.length + 1)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/**
 * Walk the (already-loaded, ACL-filtered) tree down to this plugin's namespace
 * dirs. Through `findKbRoot`, not `[kbDirName, …]` from the literal root: the
 * fileTree can carry workspace/KB-clone wrapper levels above the kb dir, and
 * that helper is how the rest of the codebase reaches the well-known root
 * dirs regardless.
 */
function namespaceListings(tree: FileTreeEntry, folder: string): NamespaceListing[] {
  const kbRoot = findKbRoot(tree);
  // `folder` is the path below the plugins root — one segment for a top-level
  // plugin, several for a nested one — and the tree is walked a segment at a time.
  const pluginDir = kbRoot ? descend(kbRoot, [PLUGINS_DIR, ...folder.split('/')]) : null;
  if (!pluginDir?.children) return [];
  const out: NamespaceListing[] = [];
  for (const child of pluginDir.children) {
    if (child.type !== 'directory' || !isNamespaceDir(child.name)) continue;
    const files: string[] = [];
    collectFiles(child, child.name, files);
    if (files.length > 0) out.push({ namespace: child.name, files: files.sort() });
  }
  return out.sort((a, b) => a.namespace.localeCompare(b.namespace));
}

function descend(tree: FileTreeEntry, segments: string[]): FileTreeEntry | null {
  let node: FileTreeEntry | undefined = tree;
  for (const segment of segments) {
    node = node?.children?.find((c) => c.name === segment);
    if (!node) return null;
  }
  return node ?? null;
}

function collectFiles(node: FileTreeEntry, prefix: string, out: string[]): void {
  for (const child of node.children ?? []) {
    const rel = `${prefix}/${child.name}`;
    if (child.type === 'directory') collectFiles(child, rel, out);
    else out.push(rel);
  }
}
