import { useMemo, useState } from 'react';
import { useLibrary } from '../state/library-data';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { GroupJoinRequests } from './GroupJoinRequests';

/**
 * Every pending join request the CALLER can answer, one banner per group they
 * manage.
 *
 * It belongs on whatever page the Library opens on — nobody visits a group to
 * find out that somebody wants into it, so the landing view is the one place a
 * request is guaranteed to be seen. That page is the all-groups index now; it
 * was the Everything gallery before, and this component exists so the surface
 * could move without being rebuilt. The group's own page carries the identical
 * banner for the person who is already there.
 *
 * It fetches per group and renders nothing for a group with nothing pending, so
 * mounting it on a page is not a promise that anything will appear.
 */
export function ManagedGroupRequests() {
  const { groupSummaries, reload, reloadGroups } = useLibrary();
  const { kbDirName } = useWorkspace();
  /** Repo-relative folder whose `access.md` the Manage-access dialog is on. */
  const [manageFolder, setManageFolder] = useState<string | null>(null);
  /** Bumped when an access edit lands, so the request surfaces refetch. */
  const [accessRevision, setAccessRevision] = useState(0);

  const managed = useMemo(
    () =>
      groupSummaries
        .filter((g) => g.canWrite)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [groupSummaries],
  );

  return (
    <>
      {managed.map((g) => (
        <GroupJoinRequests
          key={g.name}
          group={g.name}
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
            reloadGroups();
            reload();
            setAccessRevision((r) => r + 1);
          }}
        />
      )}
    </>
  );
}
