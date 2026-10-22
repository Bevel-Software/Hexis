/**
 * The page entry `full-screen-reading-width.browser.ts` bundles: mounts the
 * reduced file page (`FullScreenReading.tsx`) and hands the test its controls
 * on `window.reading`.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Reading } from './FullScreenReading';

let root: ReturnType<typeof createRoot> | null = null;
window.reading = {
  mount(opts = {}) {
    root?.unmount();
    const host = document.getElementById('root');
    if (!host) throw new Error('no #root to mount on');
    root = createRoot(host);
    root.render(
      <StrictMode>
        <Reading initialFilling={opts.filling === true} />
      </StrictMode>,
    );
  },
  enter: () => {},
  leave: () => {},
  filling: () => false,
};
