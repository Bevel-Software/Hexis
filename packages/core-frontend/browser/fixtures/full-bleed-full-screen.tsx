/**
 * The page entry `full-screen-exit-clearance.browser.ts` bundles: mounts
 * `FullBleedFile.tsx`, a full-bleed file filling the window.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FullBleedFile } from './FullBleedFile';

const host = document.getElementById('root');
if (!host) throw new Error('no #root to mount on');
createRoot(host).render(
  <StrictMode>
    <FullBleedFile />
  </StrictMode>,
);
