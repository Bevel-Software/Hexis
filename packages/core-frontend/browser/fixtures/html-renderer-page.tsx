/**
 * The page entry `html-renderer-refresh.browser.ts` bundles: the REAL HTML
 * renderer, as the file page mounts it — inside the app's router, workspace
 * and git contexts, with the file page's page-tools provider, so the frame's
 * document is built with the tool bridge exactly as on the file page.
 * Nothing here stands in for the renderer; only the file page around it.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { PageToolsContext, getFileRenderer } from '../../src/modules/workspace/components/renderers';
import { GitContext, type GitContextValue } from '../../src/modules/git';
import { WorkspaceContext, type WorkspaceContextValue } from '../../src/modules/workspace/state/workspace.context';

declare global {
  interface Window {
    /** Mount the renderer on `#root` showing `content` as `filePath`. */
    mountHtmlPage(opts: { content: string; filePath: string; pagePath: string }): void;
  }
}

const workspace = { workspaceId: 'main', kbDirName: 'knowledge-base' } as unknown as WorkspaceContextValue;
const git = { status: { branch: 'main' } } as unknown as GitContextValue;

window.mountHtmlPage = ({ content, filePath, pagePath }) => {
  const host = document.getElementById('root');
  if (!host) throw new Error('no #root to mount on');
  const HtmlRenderer = getFileRenderer(filePath);
  createRoot(host).render(
    <MemoryRouter initialEntries={[`/workspace/main/${filePath}`]}>
      <WorkspaceContext.Provider value={workspace}>
        <GitContext.Provider value={git}>
          <PageToolsContext.Provider value={{ pagePath }}>
            <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
              <HtmlRenderer content={content} filePath={filePath} onSave={async () => undefined} readOnly />
            </div>
          </PageToolsContext.Provider>
        </GitContext.Provider>
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
};
