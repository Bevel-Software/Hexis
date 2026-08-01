// SEAM: the route `/skills-and-tools/propose` and its `?group=` query are a
// FROZEN contract (master plan §1, seam 3). The navigation into this page — the
// group page's "Propose a skill or tool" button — is this feature's; everything
// this file RENDERS is a placeholder Ali replaces wholesale with the
// change-request flow (a CR that adds a file into `Groups/{group}/`). Keep the
// route and the query key; rewrite the body freely.
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Surface } from '../../../shared/components';
import { useLibrary } from '../state/library-data';
import { LIBRARY_ROOT, pathForGroup, pathForGroupsIndex } from '../routes/library-paths';
import { ownersTextOf } from '../utils/group-summary';
import { useLibraryToast } from '../state/toast';
import { COPIED_TOAST, COPY_FAILED_TOAST, copyToClipboard } from '../utils/clipboard';

/**
 * "Propose a skill or tool" — where a non-writer lands from a group page.
 *
 * You build with your agent, not here. That is not a stopgap for a missing
 * editor: a skill is a folder of files that the agent writes and the group
 * reviews, so the useful thing this page can do is hand over a prompt that
 * already names the group and already says "send it for review". Which is
 * exactly the shape the change-request flow will grow into when it replaces
 * this body.
 */
export function ProposeSkillPage() {
  const [params] = useSearchParams();
  const group = params.get('group');
  const navigate = useNavigate();
  const toast = useLibraryToast();
  const { groupSummaries } = useLibrary();

  const summary = group ? groupSummaries.find((g) => g.name === group) : undefined;
  const prompt = group
    ? `Help me build a new skill or tool and propose it for the ${group} group at Bevel. Ask me what it should do, draft it, then send it to the group for review.`
    : 'Help me build a new skill or tool at Bevel. Ask me what it should do, draft it, then send it for review.';

  async function copyPrompt() {
    toast((await copyToClipboard(prompt)) ? COPIED_TOAST : COPY_FAILED_TOAST);
  }

  return (
    <div className="pb-14">
      {group && (
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-detail text-ink-faint"
        >
          <Link to={pathForGroupsIndex()} className="rounded-xs hover:text-ink">
            All groups
          </Link>
          <span aria-hidden="true">›</span>
          <Link to={pathForGroup(group)} className="truncate rounded-xs hover:text-ink">
            {group}
          </Link>
          <span aria-hidden="true">›</span>
          <span aria-current="page" className="text-ink-muted">
            Propose
          </span>
        </nav>
      )}

      <h1 className="mt-1.5 text-display font-semibold">
        {group ? `Propose a skill or tool for ${group}` : 'Propose a skill or tool'}
      </h1>

      <p className="mt-1 max-w-2xl text-ui text-ink-muted">
        You build with your agent, not here. Tell it what you need — it drafts the skill or tool
        and sends it to this group.
      </p>

      <Surface tone="sunken" radius="md" elevation="none" padded className="mt-4 max-w-2xl">
        <p className="font-mono text-detail text-ink">{prompt}</p>
      </Surface>

      {/* Omitted when we could not resolve who reviews it. Naming the wrong
          reviewer is worse than naming none. */}
      {group && summary && (
        <p className="mt-2.5 text-detail text-ink-faint">
          {`${ownersTextOf(summary)} reviews it before it joins ${group}.`}
        </p>
      )}

      <div className="mt-5 flex items-center gap-2">
        <Button variant="primary" onClick={() => void copyPrompt()}>
          Copy prompt
        </Button>
        <Button
          variant="quiet"
          onClick={() => navigate(group ? pathForGroup(group) : LIBRARY_ROOT)}
        >
          {group ? `Back to ${group}` : 'Back to the library'}
        </Button>
      </div>
    </div>
  );
}
