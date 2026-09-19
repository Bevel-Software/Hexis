import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Surface } from '../../../shared/components';
import { pathForPluginsIndex } from '../routes/library-paths';
import { adminNamesOf, ownersTextOf, primaryFolderOf } from '../utils/plugin-summary';
import { AlreadyReadableError, requestPluginAccess, type PluginSummary } from '../services/plugins.api';
import { firstNames, joinNames } from '../utils/names';
import { useLibraryToast } from '../state/toast.context';
import { LockGlyph } from './LockGlyph';

/**
 * A plugin you cannot read, as a place you can still stand in.
 *
 * Reaching this view means the caller could read the plugin's `access.md`
 * file (the `read: everyone` discovery grant in its frontmatter) but not the
 * folder — the same tier the backend used to include the summary at all. It
 * states four facts and offers one action: the plugin exists, who runs it,
 * how much is in it, and how to ask. Item names and descriptions stay
 * members-only; asking opens a plain change request that the plugin's
 * writers approve by merging.
 *
 * It is the SAME frame as the member view — breadcrumb, h1, run-by lede — so
 * the two never read as different products. Only the middle changes.
 *
 * Asking is answered at once. The button says "Requesting…" from the click,
 * and the server replies as soon as it has RECORDED the request — the branch,
 * the commit and the change request that carry it to the managers are made
 * afterwards, in the background. Two consequences are visible here: the
 * "Requested" card can appear before the change request exists (which is
 * correct — the request is recorded, and a reload still shows the card), and
 * the background work can fail after the person was told their request was
 * sent, which is what `requestFailure` says on the next load.
 *
 * `Manage access` is the escape hatch for a locked-out platform Admin. Admin
 * rescue applies to WRITING `access.md`, not to reading the folder, so an Admin
 * can genuinely be locked out of a plugin they are nevertheless the right person
 * to unlock. `canWrite` is exactly that verdict, which is why the button hangs
 * off it and not off any role check.
 */

export interface LockedPluginViewProps {
  plugin: PluginSummary;
  /** A request landed — refetch the index so `hasRequested` comes back true. */
  onRequested(): void;
  /** Access was already granted: reload everything and let the plugin open. */
  onUnlocked(): void;
  /** Open `ManageAccessDialog` on this repo-relative folder. */
  onManage(folder: string): void;
}

export function LockedPluginView({ plugin, onRequested, onUnlocked, onManage }: LockedPluginViewProps) {
  const toast = useLibraryToast();
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);

  const admins = adminNamesOf(plugin);
  // The prose name for the same people, from the SAME helper the member view
  // uses — a plugin has to describe itself identically on both sides of the lock.
  const adminsText = ownersTextOf(plugin);
  const primaryFolder = primaryFolderOf(plugin);
  const pending = plugin.hasRequested || requested;
  // The server finishes a request in the background, so it can fail after it
  // has already been acknowledged. When it does, the index says so on the
  // next load and the button comes back — this sentence is the only place
  // the person ever learns their request did not arrive.
  const failure = !pending && plugin.requestFailure ? failureSentence(plugin, plugin.requestFailure) : null;

  async function request() {
    // The disabled button is the first guard; this is the one that holds when
    // a click arrives before React has re-rendered it.
    if (requesting) return;
    setRequesting(true);
    try {
      await requestPluginAccess(plugin.name);
      setRequested(true);
      toast(
        `Asked ${admins.length > 0 ? joinNames(firstNames(admins)) : 'the admins'}. You get its skills and tools once they grant access.`,
      );
      onRequested();
    } catch (err) {
      // Access arrived between the page load and the click. Nothing went
      // wrong — the plugin is simply open now, so open it.
      if (err instanceof AlreadyReadableError) {
        // Released BEFORE handing off, because `onUnlocked` is not guaranteed
        // to swap this view out synchronously — if it kicks off an async
        // reload, this component renders again in the meantime and the button
        // would be stuck disabled with nothing left to re-enable it.
        setRequesting(false);
        onUnlocked();
        return;
      }
      toast("Couldn't send that: try again.", 'danger');
      setRequesting(false);
    }
  }

  return (
    <div className="pb-14">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-detail text-ink-faint">
        <Link to={pathForPluginsIndex()} className="rounded-xs hover:text-ink">
          Everything
        </Link>
        <span aria-hidden="true">›</span>
        <span aria-current="page" className="truncate text-ink-muted">
          {plugin.displayName || plugin.name}
        </span>
      </nav>

      <div className="mt-1.5 flex items-center gap-2.5">
        <h1 className="text-display font-semibold">{plugin.displayName || plugin.name}</h1>
        <Badge tone="outline" size="sm">
          <LockGlyph className="size-3 shrink-0" />
          Locked
        </Badge>
      </div>

      <p className="mt-1 text-lede text-ink-muted">{`Run by ${adminsText}.`}</p>

      {/* Volume, never contents. A number tells you whether it is worth asking
          for access; a name would tell you what is inside. */}
      <p className="mt-1 text-ui text-ink-muted">{countsLine(plugin)}</p>

      <div className="mt-5">
        {pending ? (
          <Surface tone="sunken" radius="lg" elevation="none" padded className="max-w-lg">
            <p className="text-body">
              {`Requested: ${adminsText} ${admins.length === 1 ? 'decides' : 'decide'} who gets access.`}
            </p>
          </Surface>
        ) : (
          <>
            {failure && (
              <p className="mb-2.5 max-w-lg text-body text-ink-muted">{failure}</p>
            )}
            {/* The label is the acknowledgement. The click is answered in well
                under a second, so this is brief — but a button that only
                greys out says nothing about whether the click was heard, and
                that silence is what this whole flow exists to end. */}
            <Button variant="primary" disabled={requesting} onClick={() => void request()}>
              {requesting ? 'Requesting…' : 'Subscribe to this plugin'}
            </Button>
          </>
        )}
      </div>

      {plugin.canWrite && primaryFolder && (
        <div className="mt-3">
          <Button variant="quiet" onClick={() => onManage(primaryFolder)}>
            Manage access
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * `Your request to join {plugin} could not be sent: {reason}. Try again.`
 *
 * The plain sentence comes FIRST and the platform's own words follow it, so a
 * git error the person cannot act on never arrives instead of an explanation.
 * The reason is trimmed of its own trailing punctuation — it is a clause in
 * this sentence, not a sentence of its own.
 */
function failureSentence(plugin: Pick<PluginSummary, 'name' | 'displayName'>, reason: string): string {
  const name = plugin.displayName || plugin.name;
  const because = reason.trim().replace(/[.\s]+$/, '');
  return `Your request to join ${name} could not be sent: ${because}. Try again.`;
}

/**
 * `{n} skills · {n} tools — visible to members only.`
 *
 * Singular is honoured here (unlike the index rows' fixed-width label) because
 * this is a sentence somebody reads, not a column that has to line up.
 */
function countsLine(plugin: Pick<PluginSummary, 'skillCount' | 'toolCount'>): string {
  const skills = `${plugin.skillCount} ${plugin.skillCount === 1 ? 'skill' : 'skills'}`;
  const tools = `${plugin.toolCount} ${plugin.toolCount === 1 ? 'tool' : 'tools'}`;
  return `${skills} · ${tools}. Visible once you have access.`;
}

