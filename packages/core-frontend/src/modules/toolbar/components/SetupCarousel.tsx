import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { Button } from '../../../shared/components';
import { ScreenshotStep } from './ScreenshotStep';
import type { Shot } from './claude-setup-shots';

export interface CarouselSlide {
  /** The word in the progress strip. Short, because five or six share a row. */
  shortLabel: string;
  /** The half of the setup this slide belongs to, named in the eyebrow. */
  stage: string;
  title: string;
  instruction: ReactNode;
  /**
   * Usually one. The connector slide is two, because it is one action across
   * a list and the dialog it opens; splitting it would put the check that it
   * worked on a different slide from the button that does it.
   */
  shots: Shot[];
  /**
   * Anything that belongs to this slide and is not a screenshot — today only
   * the generated credentials, on the Add-configuration slide. An ELEMENT,
   * not a component: creating it costs nothing, and it is mounted only while
   * its own slide is the active one, which is what keeps a client secret out
   * of the DOM of the five slides that do not ask for it.
   */
  extra?: ReactNode;
}

/**
 * One decision at a time, for both Claude setup routes: the personal one on
 * External agent access and the admin's registration steps in Deployment
 * settings. ONE shell, so the two cannot drift into different keyboard
 * handling or a different idea of where "Review again" lives.
 *
 * Only the active slide is mounted. That is what keeps nine full-size
 * screenshots from becoming a very long page, and it is also the rule the
 * credentials rely on.
 */
export function SetupCarousel({ label, slides }: { label: string; slides: CarouselSlide[] }) {
  const [current, setCurrent] = useState(0);
  const active = slides[current];
  const atStart = current === 0;
  const atEnd = current === slides.length - 1;

  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setCurrent((step) => Math.max(0, step - 1));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setCurrent((step) => Math.min(slides.length - 1, step + 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setCurrent(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setCurrent(slides.length - 1);
    }
  }

  return (
    <section
      aria-label={label}
      aria-roledescription="carousel"
      onKeyDown={handleKeys}
      className="overflow-hidden rounded-xl border border-line bg-surface"
    >
      {/* The column count is the slide count, so a route with six steps does
          not have to remember to change a `grid-cols-5` somewhere else. */}
      <nav
        aria-label="Setup progress"
        className="grid border-b border-line"
        style={{ gridTemplateColumns: `repeat(${slides.length}, minmax(0, 1fr))` }}
      >
        {slides.map((item, index) => {
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

      {/* Live, because moving between slides never moves focus: the reader
          stays on Next or on a progress button while the title, instruction
          and screenshot underneath them all change. The eyebrow inside names
          the new position, so the footer counter does not repeat it. */}
      <div
        role="group"
        aria-roledescription="slide"
        aria-live="polite"
        aria-label={`Step ${current + 1} of ${slides.length}: ${active.title}`}
      >
        <div className="space-y-1.5 border-b border-line px-3 py-3 sm:px-4">
          <div className="text-label uppercase text-accent">
            Step {current + 1} of {slides.length} · {active.stage}
          </div>
          <h3 className="text-head font-medium text-ink">{active.title}</h3>
          <p className="max-w-4xl text-detail leading-relaxed text-ink-muted">
            {active.instruction}
          </p>
          {active.extra}
        </div>

        <div className="space-y-2 bg-sunken p-2 sm:p-3">
          {active.shots.map((shot) => (
            <ScreenshotStep key={shot.src} shot={shot} />
          ))}
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
        <span className="text-meta text-ink-faint">
          {current + 1} / {slides.length}
        </span>
        {/* One control that relabels itself, rather than two behind a
            ternary. Same rendered result — React reconciles same-type
            siblings in place, so either way the reader who pressed Next to
            reach the end keeps focus on it — but here that is the structure
            rather than a property of the reconciler, and a later `key` or an
            extra wrapper cannot quietly unmount the button under their
            focus. Losing it would take the arrow keys with it: this section
            is what handles them. */}
        <Button
          variant={atEnd ? 'outline' : 'primary'}
          size="sm"
          trailingIcon={atEnd ? <RotateCcw size={13} /> : <ChevronRight size={14} />}
          onClick={() => setCurrent((step) => (step === slides.length - 1 ? 0 : step + 1))}
        >
          {atEnd ? 'Review again' : 'Next'}
        </Button>
      </div>
    </section>
  );
}
