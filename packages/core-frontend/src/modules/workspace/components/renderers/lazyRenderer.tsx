import {
  Component,
  Suspense,
  lazy,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import type { FileRendererProps } from './types';

/**
 * Code-splitting for the renderers whose parsing libraries dominate the
 * bundle. Measured from a production build: xlsx (141 KB gzip), mammoth
 * (119 KB) and mermaid's eager core (151 KB) are 411 KB gzip — 43% of a
 * 964 KB payload — for file types most sessions never open. Every route paid
 * that, including `/connect` and `/secrets`, which are the pages users land
 * on returning from an external OAuth sign-in.
 *
 * The lazy component is self-contained: it carries its own Suspense fallback
 * AND its own error boundary, so `getFileRenderer()` keeps returning a plain
 * `ComponentType<FileRendererProps>` and no call site changes.
 *
 * The error boundary is not optional politeness. A dynamic import fails on a
 * flaky network or after a deploy invalidates the old chunk hash; without a
 * boundary React unmounts the whole tree and the user gets a blank pane with
 * no way back. This is the repo's first error boundary.
 */

interface BoundaryProps {
  children: ReactNode;
  /** Shown when the chunk fails to load. */
  label: string;
}

interface BoundaryState {
  failed: boolean;
}

class ChunkErrorBoundary extends Component<BoundaryProps, BoundaryState> {
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
        <p className="text-ui text-ink-muted">
          Could not load the {this.props.label} viewer.
        </p>
        <button
          type="button"
          className="rounded-full border border-line-strong px-[15px] py-[7px] text-ui font-medium text-ink transition-colors hover:bg-hover"
          onClick={() => this.setState({ failed: false })}
        >
          Try again
        </button>
      </div>
    );
  }
}

function RendererFallback() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <span className="text-ui text-ink-faint">Loading viewer…</span>
    </div>
  );
}

/**
 * Wrap a dynamic import as a drop-in renderer.
 *
 * @param label   Human name for the error message ("spreadsheet", "document").
 * @param loader  Dynamic import resolving to the renderer component.
 */
export function lazyRenderer(
  label: string,
  loader: () => Promise<{ default: ComponentType<FileRendererProps> }>,
): ComponentType<FileRendererProps> {
  const Lazy = lazy(loader);
  return function LazyRenderer(props: FileRendererProps) {
    return (
      <ChunkErrorBoundary label={label}>
        <Suspense fallback={<RendererFallback />}>
          <Lazy {...props} />
        </Suspense>
      </ChunkErrorBoundary>
    );
  };
}
