import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The two components a lazily-loaded renderer wraps itself in.
 *
 * They live here rather than beside `lazyRenderer` because that module's
 * export is a FACTORY, not a component. A file that mixes the two cannot be
 * hot-reloaded — React Fast Refresh can only swap a module whose exports are
 * all components — so `react-refresh/only-export-components` fails the lint.
 * Splitting on that seam gives Fast Refresh a component-only module to swap
 * and leaves the factory in a component-free one.
 */

interface BoundaryProps {
  children: ReactNode;
  /** Shown when the chunk fails to load. */
  label: string;
  /**
   * Ask the parent for a FRESH attempt. The boundary deliberately does not
   * clear its own `failed` flag: `React.lazy` memoises a rejected loader, so
   * re-rendering the same lazy component just re-throws the cached failure.
   * Recovery has to come from above, by building a new lazy component and
   * remounting this boundary with it.
   */
  onRetry(): void;
}

interface BoundaryState {
  failed: boolean;
}

/**
 * Not optional politeness. A dynamic import fails on a flaky network or after
 * a deploy invalidates the old chunk hash; without a boundary React unmounts
 * the whole tree and the user gets a blank pane with no way back.
 */
export class ChunkErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[renderer] failed to load viewer chunk', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-ui text-ink-muted">Could not load the {this.props.label} viewer.</p>
        <button
          type="button"
          className="rounded-full border border-line-strong px-[15px] py-[7px] text-ui font-medium text-ink transition-colors hover:bg-hover"
          onClick={this.props.onRetry}
        >
          Try again
        </button>
      </div>
    );
  }
}

export function RendererFallback() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <span className="text-ui text-ink-faint">Loading viewer…</span>
    </div>
  );
}
