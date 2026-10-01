import { useState } from 'react';
import { cn } from '../../../lib/utils';
import { HEADER_BAND, PAGE_HEADER_TESTID } from '../../../shared/theme/header';
import { Badge, Button, Surface } from '../../../shared/components';
import { adminNamesOf, ownersTextOf, primaryFolderOf } from '../utils/plugin-summary';
import { AlreadyReadableError, requestPluginAccess, type PluginSummary } from '../services/plugins.api';
import { firstNames, joinNames } from '../utils/names';
import { useLibraryToast } from '../state/toast.context';
import { LockGlyph } from './LockGlyph';
import { PluginBreadcrumb } from './plugin-page-parts';

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
 * ASKING HAS THREE STATES, and the button carries two of them. It reads
 * "Requesting…" and refuses further clicks from the moment it is pressed
 * until the server answers; the "Requested" card replaces it on that answer,
 * which the server gives as soon as it has RECORDED the request rather than
 * once the change request exists. If the git work that follows the answer
 * fails, the next load has `requestFailure` set and no request standing, so
 * the button is back with a sentence above it naming what went wrong —
 * pressing it again continues the recorded request rather than opening a
 * second one.
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
  // The server could not finish the last request. It says so only while there
  // is no request standing — `hasRequested` and this are never both true —
  // so the sentence always sits above a button the person can press again.
  const failure = pending ? null : (plugin.requestFailure ?? null);

  async function request() {
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
      {/* The same band every other page title bar is on, so a plugin you
          cannot open still lines its heading up with the nav beside it — and
          the page's FIRST row, with the breadcrumb on the band rather than
          above it, for the same reason. `PluginBreadcrumb` is the one an
          openable plugin page uses; a locked page is still a plugin page, and
          two copies of one trail drift the first time either is touched. */}
      <div data-testid={PAGE_HEADER_TESTID} className={cn(HEADER_BAND, 'gap-2.5')}>
        <PluginBreadcrumb />
        <h1
          className="min-w-0 truncate text-display font-semibold"
          title={plugin.displayName || plugin.name}
        >
          {plugin.displayName || plugin.name}
        </h1>
        <Badge tone="outline" size="sm">
          <LockGlyph className="size-3 shrink-0" />
          Locked
        </Badge>
      </div>

      <p className="mt-1 text-lede text-ink-muted">{`Run by ${adminsText}.`}</p>

      {/* Volume, never contents. A number tells you whether it is worth asking
          for access; a name would tell you what is inside. */}
      <p className="mt-1 text-ui text-ink-muted">{countsLine(plugin)}</p>

      {/* The in-flight word for assistive tech, matching `LinkSkillPanel`.
          The button says "Requesting…" too, but pressing it disables it and a
          disabled button drops focus, so that label change is never read out.
          The acknowledgement is the whole point of this ticket, and it has to
          reach somebody who cannot see the label.

          `pending`, not `requesting`, is what ends it. The success path never
          clears `requesting` — deliberately, so the button cannot flicker back
          to life between the answer and the swap to the Requested card — which
          left this region presenting "Requesting access to …" for as long as
          the page stayed up. A screen-reader user arriving at the region after
          the card had rendered was told the request was still going. */}
      <span role="status" aria-live="polite" aria-label="Request progress" className="sr-only">
        {requesting && !pending ? `Requesting access to ${plugin.displayName || plugin.name}…` : ''}
      </span>

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
              <p className="mb-2.5 max-w-lg text-body text-ink-muted">
                {`Your request to join ${plugin.displayName || plugin.name} could not be sent: ${failure}. Try again.`}
              </p>
            )}
            {/* The label is the acknowledgement. Nothing else on the page can
                say "we heard you" in the render that follows the click — the
                server's answer is a round-trip away, and the whole reason the
                click used to look like a freeze is that this button greyed out
                and kept its word. */}
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

