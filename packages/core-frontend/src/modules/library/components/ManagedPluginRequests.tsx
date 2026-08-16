import { useMemo, useState } from 'react';
import { useLibrary } from '../state/library-data';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { PluginJoinRequests } from './PluginJoinRequests';

/**
 * Every pending join request the CALLER can answer, one banner per plugin they
 * manage.
 *
 * It belongs on whatever page the Library opens on — nobody visits a plugin to
 * find out that somebody wants into it, so the landing view is the one place a
 * request is guaranteed to be seen. That page is the all-plugins index now; it
 * was the Everything gallery before, and this component exists so the surface
 * could move without being rebuilt. The plugin's own page carries the identical
 * banner for the person who is already there.
 *
 * It fetches per plugin and renders nothing for a plugin with nothing pending, so
 * mounting it on a page is not a promise that anything will appear.
 */
export function ManagedPluginRequests() {
  const { pluginSummaries, reload, reloadPlugins } = useLibrary();
  const { kbDirName } = useWorkspace();
  /** Repo-relative folder whose `access.md` the Manage-access dialog is on. */
  const [manageFolder, setManageFolder] = useState<string | null>(null);
  /** Bumped when an access edit lands, so the request surfaces refetch. */
  const [accessRevision, setAccessRevision] = useState(0);

  const managed = useMemo(
    () =>
      pluginSummaries
        .filter((g) => g.canWrite)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [pluginSummaries],
  );

  return (
    <>
      {managed.map((g) => (
        <PluginJoinRequests
          key={g.name}
          plugin={g.name}
          folders={g.folders}
          onManage={setManageFolder}
          reloadSignal={accessRevision}
        />
      ))}

      {/* `kbDirName` gates it — the resolver addresses files repo-relative
          and the dialog strips that prefix, so without it the path we hand
          over is not the path we mean. */}
      {manageFolder && kbDirName && (
        <ManageAccessDialog
          entry={{
            name: manageFolder.split('/').pop() ?? manageFolder,
            relativePath: `${kbDirName}/${manageFolder}`,
            type: 'directory',
          }}
          onClose={() => {
            setManageFolder(null);
            reloadPlugins();
            reload();
            setAccessRevision((r) => r + 1);
          }}
        />
      )}
    </>
  );
}
