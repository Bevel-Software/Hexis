import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_BRANCH, type FileTreeEntry } from '@bevel-software/platform-shared';
import { Button } from '../../../shared/components';
import { listFiles } from '../../workspace/services/workspace.api';
import { kbFileUrl } from '../../workspace/routing/kb-routes';

/**
 * The plugin page's two smallest sections, both pure REUSE of the Knowledge
 * surface: every link is a `kbFileUrl` + `rawFile` navigation into the same
 * raw editor the tool page's "Edit the tool file" uses — no new viewer, no new
 * backend.
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
        navigate(kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/Plugins/${folder}/plugin.json`), {
          state: { rawFile: true },
        })
      }
    >
      Manifest
    </Button>
  );
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
  const [listings, setListings] = useState<NamespaceListing[]>([]);

  useEffect(() => {
    // Reset FIRST: on a folder change or a failed refetch, stale state would
    // keep rendering the previous plugin's files under the new plugin's name.
    setListings([]);
    if (!kbDirName) return;
    let live = true;
    listFiles(workspaceId)
      .then((tree) => {
        if (live) setListings(namespaceListings(tree, kbDirName, folder));
      })
      .catch(() => {
        /* the section renders nothing — a tree fetch failure is not this page's story */
      });
    return () => {
      live = false;
    };
  }, [workspaceId, kbDirName, folder]);

  if (listings.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-2.5 text-label font-semibold uppercase text-ink-faint">
        Client-specific extensions
      </h2>
      <p className="mb-2 max-w-[62ch] text-detail text-ink-muted">
        Reverse-DNS directories carry data for a specific client; other clients ignore them. Files
        open in the Knowledge editor.
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
                    navigate(kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/Plugins/${folder}/${f}`), {
                      state: { rawFile: true },
                    })
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

/** Walk the (already-loaded, ACL-filtered) tree down to this plugin's namespace dirs. */
function namespaceListings(tree: FileTreeEntry, kbDirName: string, folder: string): NamespaceListing[] {
  const pluginDir = descend(tree, [kbDirName, 'Plugins', folder]);
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
