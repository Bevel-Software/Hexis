/**
 * The page entry `editor-line-endings.browser.ts` bundles: the two editors a
 * person saves a file from, each over a real `<textarea>`.
 *
 *  - The REAL renderer the file page and the embed edit in (`pickFileRenderer`),
 *    held the way the file page holds it: the host keeps the typed text the
 *    renderer hands it, writes what Ctrl+S hands it, and writes the typed text
 *    on Done.
 *  - The REAL skill page editor (`SkillFileEditor`), whose Save writes what it
 *    submits.
 *
 * Every write lands in `window.written`, byte for byte.
 */
import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { GitContext, type GitContextValue } from '../../src/modules/git';
import { WorkspaceContext, pickFileRenderer, type WorkspaceContextValue } from '../../src/modules/workspace';
import { SkillFileEditor } from '../../src/modules/library/components/skill-page/SkillFileEditor';

declare global {
  interface Window {
    /** What the editors on this page would have written, in order. */
    written: string[];
    /** Mount the file page's editor for `filePath`, opened on `content`. */
    mountFileEditor(opts: { content: string; filePath: string }): void;
    /** Mount the skill page's editor, opened on `content`. */
    mountSkillEditor(opts: { content: string }): void;
  }
}

const workspace = { workspaceId: 'main', kbDirName: 'knowledge-base' } as unknown as WorkspaceContextValue;
const git = { status: { branch: 'main' } } as unknown as GitContextValue;
window.written = [];

/** The file page's hold on its renderer: the typed text, what Ctrl+S hands it, and Done. */
export function FileEditor({
  Renderer,
  content,
  filePath,
}: {
  Renderer: ReturnType<typeof pickFileRenderer>;
  content: string;
  filePath: string;
}) {
  const [saved, setSaved] = useState(content);
  const [buffer, setBuffer] = useState(content);
  const write = (bytes: string) => {
    window.written.push(bytes);
    setSaved(bytes);
  };
  return (
    <>
      <button type="button" onClick={() => write(buffer)}>
        Done
      </button>
      <Renderer
        content={buffer}
        savedContent={saved}
        filePath={filePath}
        readOnly={false}
        onValueChange={setBuffer}
        onSave={async (bytes) => {
          write(bytes);
          setBuffer(bytes);
        }}
      />
    </>
  );
}

function mount(node: ReactNode) {
  const host = document.getElementById('root');
  if (!host) throw new Error('no #root to mount on');
  createRoot(host).render(node);
}

window.mountFileEditor = ({ content, filePath }) =>
  mount(
    <MemoryRouter initialEntries={[`/workspace/main/${filePath}`]}>
      <WorkspaceContext.Provider value={workspace}>
        <GitContext.Provider value={git}>
          <FileEditor Renderer={pickFileRenderer(filePath)} content={content} filePath={filePath} />
        </GitContext.Provider>
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );

window.mountSkillEditor = ({ content }) =>
  mount(
    <SkillFileEditor
      file="SKILL.md"
      base={content}
      mode="edit"
      owner=""
      onCancel={() => undefined}
      onSubmit={async (next) => {
        window.written.push(next);
      }}
    />,
  );
