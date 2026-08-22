import { Suspense, lazy, useMemo, useState, type ComponentType } from 'react';
import { ChunkErrorBoundary, RendererFallback } from './chunk-boundary';
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
 */

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
  // Shared across every mount, and the reason "Try again" needs the dance
  // below: `React.lazy` memoises the loader's outcome — including a REJECTION.
  // Once this one has failed it throws the cached error forever, so clearing
  // the boundary and re-rendering it is not a retry, it is the same failure
  // again. Only a new lazy component can actually re-run the import.
  const first = lazy(loader);

  function LazyRenderer(props: FileRendererProps) {
    const [attempt, setAttempt] = useState(0);

    // Attempt 0 reuses the shared component so the common path is unchanged:
    // a chunk already in the module cache resolves without re-suspending.
    // Every later attempt builds a fresh lazy, which re-runs `import()` — cheap
    // when the chunk is cached, and a real retry when it is not.
    const Lazy = useMemo(() => (attempt === 0 ? first : lazy(loader)), [attempt]);

    return (
      // `key` remounts the boundary, which is what clears its `failed` state —
      // the boundary never resets itself, so the new lazy and a clean boundary
      // always arrive together.
      <ChunkErrorBoundary
        key={attempt}
        label={label}
        onRetry={() => setAttempt((a) => a + 1)}
      >
        <Suspense fallback={<RendererFallback />}>
          <Lazy {...props} />
        </Suspense>
      </ChunkErrorBoundary>
    );
  }

  // Names the wrapper after what it loads. Every wrapper is otherwise the
  // same anonymous `LazyRenderer`, and the selection tests (and React
  // DevTools) need to tell "the PDF viewer" from "the spreadsheet viewer"
  // WITHOUT importing the heavy chunks they exist to defer.
  LazyRenderer.displayName = `LazyRenderer(${label})`;
  return LazyRenderer;
}
