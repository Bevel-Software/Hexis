import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../../lib/utils';
import { Banner, Button, buttonClasses } from '../../../../shared/components';
import { useToolPage } from '../../hooks/useToolPage';
import { useToolSource } from '../../hooks/useToolSource';
import { McpServerSection } from './McpServerSection';
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
    // Consume the OAuth `#…` fragment, KEEPING the query string: on an
    // mcp-declared tool the `?server=<slug>` param is the page's identity, and
    // replacing with the bare pathname stranded a refresh (or any URL copy) on
    // the ambiguous mcp.json address, which bounces to the plugin page.
    if (oauthOutcome) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, [oauthOutcome]);

  // Same rule as the skill page: back goes to the page the tool LIVES on —
  // its plugin, or the personal page — never to a root the reader may not
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
            PLUGIN — a tool inherits its folder's `access.md`, so an editor on
            this page would either duplicate the plugin's one or quietly write a
            per-file override that nobody looking at the plugin would see. The
            plugin's `Share` panel is the single place. */}
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

      {/* Only an mcp-type tool can have an mcp.json server pair — mounting the
          section for inline/http manuals sends a `/server` GET whose 404 is
          guaranteed. (A `.tool`-declared mcp manual still 404s and the section
          self-hides on the null; the type cannot pre-decide that case.) */}
      {tool.type === 'mcp' && (
        <McpServerSection
          slug={tool.slug}
          configuredCount={tool.variables.filter((v) => v.adminConfigured || v.userConfigured || v.authorized === true).length}
          onSaved={() => {
            setActionError(null);
            page.reload();
          }}
          onError={setActionError}
        />
      )}

      {page.detail && page.detail.capabilities.length > 0 && (
        <CapabilitiesSection capabilities={page.detail.capabilities} />
      )}

      <PoweredSkillsSection skills={page.poweredSkills} loaded={page.skillsLoaded} />

      <div className="mt-6 border-t border-line pt-3 text-detail text-ink-faint">
        Managed by the Admins.
      </div>

      {/* Last, and for EVERY type: `path` is the file the platform reads to
          make this tool — the `.tool`, or the plugin `mcp.json` that declares
          the server. */}
      <SourceSection path={tool.path} />
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

/**
 * The definition file, as text, behind a closed disclosure.
 *
 * A WINDOW, NOT AN EDITOR. The file is edited where files are edited; showing
 * it here is what saves a developer the trip to the knowledge tree to answer
 * "which template does this capability use" — and nothing in this section can
 * change it.
 *
 * Closed by default is the mechanism, not just the default: the read hangs off
 * the open state (`useToolSource`), so a reader who never opens the section
 * never costs a file read, and everything above it renders the same whether
 * the read succeeds, fails, or never happens.
 */
function SourceSection({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const source = useToolSource(path, open);
  const panelId = useId();
  const buttonId = useId();
  // Open and neither settled state: the read is in flight.
  const loading = open && source.status !== 'loaded' && source.status !== 'error';

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <button
          id={buttonId}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex items-center gap-1.5 text-label font-semibold uppercase text-ink-faint transition-colors hover:text-ink"
        >
          <ChevronRight
            size={11}
            className={cn('transition-transform duration-150', open && 'rotate-90')}
          />
          Source
        </button>
        <span className="min-w-0 truncate font-mono text-meta text-ink-faint" title={path}>
          {path}
        </span>
      </div>

      {/* Always in the tree, so `aria-controls` never points at nothing; the
          CONTENT is what is conditional, which is what keeps the read lazy.

          A labelled region that is live and busy while the read runs: a
          screen reader otherwise hears the button flip to "expanded" and
          then nothing, because the content arrives a fetch later. `polite`
          — the source is worth hearing, not worth interrupting for. */}
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        aria-live="polite"
        aria-busy={loading}
        hidden={!open}
      >
        {open &&
          (source.status === 'error' ? (
            <p className="mt-2.5 text-detail text-ink-muted">Couldn't load the source.</p>
          ) : source.status === 'loaded' ? (
            /* `whitespace-pre` and nothing else: the bytes are shown as the
               platform stores them — no wrapping, reindenting or trimming.
               Long lines scroll rather than fold. */
            <pre className="mt-2.5 max-h-[32rem] select-text overflow-auto whitespace-pre rounded-lg border border-line bg-sunken p-3 font-mono text-meta leading-relaxed text-ink">
              {source.content}
            </pre>
          ) : (
            <p className="mt-2.5 text-detail text-ink-faint">Loading the source…</p>
          ))}
      </div>
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
