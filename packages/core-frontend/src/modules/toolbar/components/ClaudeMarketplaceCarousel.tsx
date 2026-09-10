import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { Button } from '../../../shared/components';
import { ScreenshotStep } from './ScreenshotStep';
import {
  addMarketplaceShot,
  installPluginsShot,
  pasteUrlShot,
  pluginsAddShot,
  selectRepositoryShot,
  type Shot,
} from './claude-setup-shots';

const CLAUDE_CODE_WEB = 'https://claude.ai/code';
const CLAUDE_WEB = 'https://claude.ai';

interface CarouselSlide {
  shortLabel: string;
  stage: string;
  title: string;
  instruction: ReactNode;
  shot: Shot;
}

function slides(host: string): CarouselSlide[] {
  return [
    {
      shortLabel: 'Connect',
      stage: 'Connect your account',
      title: 'Select this deployment in Claude Code',
      instruction: (
        <>
          Open{' '}
          <a
            href={CLAUDE_CODE_WEB}
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-ink-muted hover:text-ink"
          >
            Claude Code on the web↗
          </a>
          . You do not need to start a coding task. Choose <b>Select repository</b>, then click{' '}
          <b>Connect to URL</b> and select <b>{host}</b>. Do not use <b>Connect to GitHub</b> — that
          signs you in to github.com instead. Approve the sign-in here and Claude returns you to the
          repository picker.
        </>
      ),
      shot: selectRepositoryShot,
    },
    {
      shortLabel: 'Plugins',
      stage: 'Add the marketplace',
      title: 'Open the Plugins menu',
      instruction: (
        <>
          Back in Cowork or on{' '}
          <a
            href={CLAUDE_WEB}
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-ink-muted hover:text-ink"
          >
            claude.ai↗
          </a>
          , open <b>Customize</b>, select the <b>Plugins</b> tab, then choose <b>Add</b>.
        </>
      ),
      shot: pluginsAddShot,
    },
    {
      shortLabel: 'Marketplace',
      stage: 'Add the marketplace',
      title: 'Choose Add marketplace',
      instruction: (
        <>
          In the Add menu, choose <b>Add marketplace</b>. This opens the field where Claude can
          fetch this deployment's plugin catalog.
        </>
      ),
      shot: addMarketplaceShot,
    },
    {
      shortLabel: 'Sync',
      stage: 'Add the marketplace',
      title: 'Paste the URL and sync',
      instruction: (
        <>
          Paste the <b>Marketplace URL</b> copied above into the URL field, then choose <b>Sync</b>.
          Syncing makes the plugins available; it does not install them yet.
        </>
      ),
      shot: pasteUrlShot,
    },
    {
      shortLabel: 'Install',
      stage: 'Install the plugin',
      title: 'Add Hexis all',
      instruction: (
        <>
          Open <b>Discover</b> and choose the <b>Hexis all</b> row to install every skill you may
          read, plus the knowledge base MCP server. The other rows are smaller subsets if you prefer
          to pick. Use <b>Update</b> in Claude to pull changes later.
        </>
      ),
      shot: installPluginsShot,
    },
  ];
}

/**
 * The non-admin path is a single decision at a time. Only the active image is
 * mounted, which avoids turning five full-size screenshots into a long page
 * and still leaves every step directly reachable from the progress strip.
 */
export function ClaudeMarketplaceCarousel({ host }: { host: string }) {
  const items = slides(host);
  const [current, setCurrent] = useState(0);
  const active = items[current];
  const atStart = current === 0;
  const atEnd = current === items.length - 1;

  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setCurrent((step) => Math.max(0, step - 1));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setCurrent((step) => Math.min(items.length - 1, step + 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setCurrent(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setCurrent(items.length - 1);
    }
  }

  return (
    <section
      aria-label="Set up the Claude marketplace"
      aria-roledescription="carousel"
      onKeyDown={handleKeys}
      className="overflow-hidden rounded-xl border border-line bg-surface"
    >
      <nav aria-label="Setup progress" className="grid grid-cols-5 border-b border-line">
        {items.map((item, index) => {
          const complete = index < current;
          const selected = index === current;
          return (
            <button
              key={item.shortLabel}
              type="button"
              aria-label={`Go to step ${index + 1}: ${item.shortLabel}`}
              aria-current={selected ? 'step' : undefined}
              onClick={() => setCurrent(index)}
              className={`flex min-w-0 items-center justify-center gap-1.5 border-r border-line px-1.5 py-2 text-meta transition-colors last:border-r-0 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink-muted ${
                selected ? 'bg-sunken font-medium text-ink' : 'text-ink-muted'
              }`}
            >
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-micro ${
                  selected
                    ? 'bg-accent text-white'
                    : complete
                    ? 'bg-ok-soft text-ok'
                    : 'bg-sunken text-ink-faint'
                }`}
              >
                {complete ? <Check size={11} strokeWidth={2.5} /> : index + 1}
              </span>
              <span className="hidden truncate min-[640px]:inline">{item.shortLabel}</span>
            </button>
          );
        })}
      </nav>

      <div
        role="group"
        aria-roledescription="slide"
        aria-label={`Step ${current + 1} of ${items.length}: ${active.title}`}
      >
        <div className="space-y-1.5 border-b border-line px-3 py-3 sm:px-4">
          <div className="text-label uppercase text-accent">
            Step {current + 1} of {items.length} · {active.stage}
          </div>
          <h3 className="text-head font-medium text-ink">{active.title}</h3>
          <p className="max-w-4xl text-detail leading-relaxed text-ink-muted">
            {active.instruction}
          </p>
        </div>

        <div className="bg-sunken p-2 sm:p-3">
          <ScreenshotStep shot={active.shot} />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2.5 sm:px-4">
        <Button
          variant="quiet"
          size="sm"
          leadingIcon={<ChevronLeft size={14} />}
          disabled={atStart}
          onClick={() => setCurrent((step) => Math.max(0, step - 1))}
        >
          Back
        </Button>
        <span className="text-meta text-ink-faint" aria-live="polite">
          {current + 1} / {items.length}
        </span>
        {atEnd ? (
          <Button
            variant="outline"
            size="sm"
            trailingIcon={<RotateCcw size={13} />}
            onClick={() => setCurrent(0)}
          >
            Review again
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            trailingIcon={<ChevronRight size={14} />}
            onClick={() => setCurrent((step) => Math.min(items.length - 1, step + 1))}
          >
            Next
          </Button>
        )}
      </div>
    </section>
  );
}
