import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Banner, Button, buttonClasses } from '../../../../shared/components';
import { useToolPage } from '../../hooks/useToolPage';
import { libraryHomeForItemPath, LIBRARY_ROOT } from '../../routes/library-paths';
import { readOAuthFragment } from '../../utils/oauth-fragment';
import type { ToolCapability } from '../../services/tools.api';
import type { LibrarySkillSummary } from '../../services/library.api';
import { ToolConnectionSection } from './ToolConnectionSection';
import { ToolLogo } from '../ToolLogo';

/**
 * One tool, as a page.
 *
 * This replaces the Library dialog's integration half, and the reason it is a
 * ROUTE and not a bigger dialog is the OAuth round-trip: signing in leaves the
 * app entirely and comes back through the provider and our callback, which can
 * only return the browser to a URL. A dialog has no URL, so the old flow could
 * only ever land you back on `/connect`, away from what you were doing.
 *
 * Three signals gate what renders, and roles are none of them:
 *  - read access to the `.tool` — implied by the tool appearing in the secrets
 *    listing at all. Absent ⇒ the not-found state, which is deliberately the
 *    same state as a typo'd slug (fail-closed: a distinct "you can't see this"
 *    would confirm the tool exists).
 *  - `tool.canWrite` — the owner-side affordances, from the per-file ACL.
 */
export function ToolPage({
  slug: slugProp,
}: {
  /**
   * Provided when the page is mounted at its canonical address — the `.tool`
   * file's own /workspace URL (see `WorkspaceItemGate`). Absent on the legacy
   * `/skills-and-tools/tools/:slug` mount, which now only hosts the redirect
   * and the OAuth return.
   */
  slug?: string;
} = {}) {
  const { slug: rawSlug = '' } = useParams<{ slug: string }>();
  const slug = slugProp ?? safeDecode(rawSlug);
  const navigate = useNavigate();
  const page = useToolPage(slug);

  // Read ONCE, synchronously, before the strip effect below runs — an effect
  // here would race the stripper and lose the outcome. Kept apart from
  // `actionError` so a successful reload can't clear a callback failure.
  const [oauthOutcome] = useState(readOAuthFragment);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (oauthOutcome) window.history.replaceState(null, '', window.location.pathname);
  }, [oauthOutcome]);

  // Same rule as the skill page: back goes to the page the tool LIVES on —
  // its group, or the personal page — never to a root the reader may not
  // have come from. Falls back to the root while the tool is still loading.
  const home = libraryHomeForItemPath(page.tool?.path ?? '');
  const backLink = (
    <Button variant="quiet" size="sm" onClick={() => navigate(home.path)}>
      {`‹ ${home.label}`}
    </Button>
  );

  if (page.loading) {
    return <div className="py-16 text-center text-ui text-ink-muted">Loading…</div>;
  }

  if (page.error) {
    return (
      <Article>
        {backLink}
        <Banner tone="danger" role="alert" className="mt-4">
          <div className="flex flex-wrap items-center gap-3">
            <span>{page.error}</span>
            <Button variant="outline" size="sm" onClick={page.reload}>
              Try again
            </Button>
          </div>
        </Banner>
      </Article>
    );
  }

  if (page.notFound || !page.tool) {
    return (
      <Article>
        {backLink}
        <p className="mt-4 text-label font-semibold uppercase text-ink-faint">Tool</p>
        <p className="mt-2 text-body text-ink-muted">
          This tool doesn't exist, or you don't have access to it.
        </p>
      </Article>
    );
  }

  const tool = page.tool;

  return (
    <Article>
      {oauthOutcome?.kind === 'authorized' && (
        <Banner tone="ok" role="status" className="mb-4">
          Signed in to {tool.name}.
        </Banner>
      )}
      {oauthOutcome?.kind === 'error' && (
        <Banner tone="danger" role="alert" className="mb-4">
          {oauthOutcome.message}
        </Banner>
      )}

      {backLink}

      <header className="mt-4 flex items-start gap-4">
        <ToolLogo slug={tool.slug} name={tool.name} size="lg" className="mt-1" />
        <div className="min-w-0 flex-1">
          <h1 className="text-display font-semibold text-ink">{tool.name}</h1>
          {page.detail?.description && (
            <p className="mt-1.5 max-w-[56ch] text-lede text-ink-muted">
              {page.detail.description}
            </p>
          )}
        </div>
        {/* No `Manage access` here, deliberately. Access is decided at the
            GROUP — a tool inherits its folder's `access.md`, so an editor on
            this page would either duplicate the group's one or quietly write a
            per-file override that nobody looking at the group would see. The
            group's `Share` panel is the single place. */}
      </header>

      {actionError && (
        <Banner tone="danger" role="alert" className="mt-4">
          {actionError}
        </Banner>
      )}

      <ToolConnectionSection
        tool={tool}
        onChanged={() => {
          setActionError(null);
          page.reload();
        }}
        onError={setActionError}
      />

      {page.detail && page.detail.capabilities.length > 0 && (
        <CapabilitiesSection capabilities={page.detail.capabilities} />
      )}

      <PoweredSkillsSection skills={page.poweredSkills} loaded={page.skillsLoaded} />

      <div className="mt-6 border-t border-line pt-3 text-detail text-ink-faint">
        Managed by the Admins.
      </div>

    </Article>
  );
}

/**
 * The reading column. Horizontal and vertical padding come from the Library
 * layout's `<main>`, which already wraps every page under `/skills-and-tools` —
 * repeating them here would double the gutter.
 */
function Article({ children }: { children: ReactNode }) {
  return <article className="mx-auto w-full max-w-3xl">{children}</article>;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-2.5 text-label font-semibold uppercase text-ink-faint">{children}</h2>;
}

function CapabilitiesSection({ capabilities }: { capabilities: ToolCapability[] }) {
  return (
    <section className="mt-8">
      <SectionHeading>What it lets the assistant do</SectionHeading>
      <ul>
        {capabilities.map((c) => (
          <li key={c.name} className="text-body text-ink-muted">
            · {c.description ?? c.name}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The reverse index. `loaded` is not cosmetic: the skill catalog degrades to
 * `[]` on failure, so rendering "No skills use this yet." before it settles
 * would state as fact something we simply don't know.
 */
function PoweredSkillsSection({
  skills,
  loaded,
}: {
  skills: LibrarySkillSummary[];
  loaded: boolean;
}) {
  return (
    <section className="mt-8">
      <SectionHeading>Powers these skills</SectionHeading>
      {!loaded ? null : skills.length === 0 ? (
        <p className="text-detail text-ink-muted">No skills use this yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {skills.map((s) => (
            <Link
              key={s.name}
              to={`${LIBRARY_ROOT}/skills/${encodeURIComponent(s.name)}`}
              className={buttonClasses({ variant: 'outline', size: 'tiny' })}
            >
              {s.name}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

/** A malformed escape is a bad link, not a crash — fall back to the raw segment. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
