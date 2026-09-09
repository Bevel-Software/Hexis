import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { DEFAULT_BRANCH, type FileTreeEntry } from '@bevel-software/platform-shared';
import { WorkspaceContext, type WorkspaceContextValue } from '../../workspace/state/workspace.context';
import { makeWorkspaceFixture } from '../../workspace/__tests__/testFixtures';
import { PluginsTree, SkillsTree } from '../components/SkillsTree';

/**
 * The Skills section of the Library nav: the shared root as Knowledge's tree
 * rows, the root itself a collapsible folder row like Knowledge and Data in
 * the explorer, with the two things that differ from Knowledge — where a
 * click goes (the skill page, on the default branch) and which row is
 * current (the file the URL names).
 */

const KB = 'knowledge-base';

const file = (rel: string): FileTreeEntry => ({ name: rel.split('/').pop()!, relativePath: rel, type: 'file' });
const dir = (rel: string, children: FileTreeEntry[]): FileTreeEntry => ({
  name: rel.split('/').pop()!,
  relativePath: rel,
  type: 'directory',
  children,
});

const TREE: FileTreeEntry = dir('.', [
  dir(KB, [
    dir(`${KB}/KnowledgeBase`, [file(`${KB}/KnowledgeBase/Handbook.md`)]),
    dir(`${KB}/Skills`, [
      dir(`${KB}/Skills/Engineering`, [
        dir(`${KB}/Skills/Engineering/deploy`, [file(`${KB}/Skills/Engineering/deploy/SKILL.md`)]),
      ]),
      dir(`${KB}/Skills/Sales`, [
        dir(`${KB}/Skills/Sales/discovery-call`, [
          file(`${KB}/Skills/Sales/discovery-call/SKILL.md`),
          file(`${KB}/Skills/Sales/discovery-call/checklist.md`),
        ]),
      ]),
    ]),
  ]),
]);

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="pathname">{location.pathname}</div>;
}

function renderTree(url: string, over: Partial<WorkspaceContextValue> = {}) {
  const workspace = makeWorkspaceFixture({ fileTree: TREE, kbDirName: KB, ...over });
  const view = render(
    <MemoryRouter initialEntries={[url]}>
      <WorkspaceContext.Provider value={workspace}>
        <SkillsTree />
        <LocationProbe />
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
  return { workspace, ...view };
}

const row = (name: string) => screen.getByRole('button', { name });

describe('SkillsTree', () => {
  it('draws the root as a folder row, open with its scopes collapsed under it', () => {
    renderTree('/skills-and-tools');
    expect(row('Skills')).toHaveAttribute('aria-expanded', 'true');
    // The scopes sit under the root, collapsed until opened.
    expect(row('Engineering')).toBeInTheDocument();
    expect(row('Sales')).toBeInTheDocument();
    expect(screen.queryByText('deploy')).not.toBeInTheDocument();
    expect(screen.queryByText('discovery-call')).not.toBeInTheDocument();
  });

  it('collapses and reopens like any folder — Knowledge and Data get the same row', () => {
    renderTree('/skills-and-tools');
    fireEvent.click(row('Skills'));
    expect(row('Skills')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Engineering' })).not.toBeInTheDocument();
    fireEvent.click(row('Skills'));
    expect(row('Engineering')).toBeInTheDocument();
  });

  it('reveals and marks the file the URL names — the Library never sets an open tab', () => {
    renderTree(`/workspace/${DEFAULT_BRANCH}/${KB}/Skills/Sales/discovery-call/checklist.md`, {
      openFilePath: null,
    });
    expect(row('checklist.md')).toHaveAttribute('aria-current', 'true');
    expect(row('SKILL.md')).toHaveAttribute('aria-current', 'false');
    // The other scope stays shut: only the named file's folders open.
    expect(screen.queryByText('deploy')).not.toBeInTheDocument();
  });

  it('opens a clicked file on its skill page, on the default branch, whatever is checked out', () => {
    renderTree('/skills-and-tools');
    fireEvent.click(row('Sales'));
    fireEvent.click(row('discovery-call'));
    fireEvent.click(row('SKILL.md'));
    expect(screen.getByLabelText('pathname')).toHaveTextContent(
      `/workspace/${DEFAULT_BRANCH}/${KB}/Skills/Sales/discovery-call/SKILL.md`,
    );
  });

  it('draws the Skills folder even when the knowledge base has none yet, and creates it on first use', () => {
    const noSkills = dir('.', [dir(KB, [dir(`${KB}/KnowledgeBase`, [])])]);
    const createDirectory = vi.fn().mockResolvedValue(undefined);
    const dispatchUpload = vi.fn().mockResolvedValue(undefined);
    renderTree('/skills-and-tools', { fileTree: noSkills, createDirectory, dispatchUpload });
    // The row is there, empty: nothing beneath it, and — with nothing to
    // open — no claim to be expanded either.
    const skills = row('Skills');
    expect(skills).toBeInTheDocument();
    expect(skills).not.toHaveAttribute('aria-expanded');
    expect(screen.queryByRole('button', { name: 'Engineering' })).not.toBeInTheDocument();
    // What writes is offered; what would read a folder that is not there is not.
    fireEvent.contextMenu(skills);
    const menu = screen.getByRole('menu', { name: 'Actions for Skills' });
    expect(within(menu).getByRole('menuitem', { name: /New folder/ })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /Download/ })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    // A new scope goes to the folder's future path — the write creates it.
    fireEvent.click(screen.getByRole('button', { name: 'New folder in Skills' }));
    const input = screen.getByPlaceholderText('folder name');
    fireEvent.change(input, { target: { value: 'Marketing' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(createDirectory).toHaveBeenCalledWith(`${KB}/Skills/Marketing`);

    // So does a drop.
    const dropped = new File(['x'], 'SKILL.md');
    fireEvent.drop(skills, { dataTransfer: { getData: () => '', items: undefined, files: [dropped] } });
    expect(dispatchUpload).toHaveBeenCalledWith({ kind: 'files', files: [dropped] }, `${KB}/Skills`);
  });

  it('renders nothing while the tree has not loaded', () => {
    renderTree('/skills-and-tools', { fileTree: null });
    expect(screen.queryByText('Skills')).not.toBeInTheDocument();
  });

  it('takes a drop on the root row, uploading into Skills/', () => {
    const dispatchUpload = vi.fn().mockResolvedValue(undefined);
    renderTree('/skills-and-tools', { dispatchUpload });
    const dropped = new File(['x'], 'notes.md');
    fireEvent.drop(row('Skills'), {
      dataTransfer: { getData: () => '', items: undefined, files: [dropped] },
    });
    expect(dispatchUpload).toHaveBeenCalledWith({ kind: 'files', files: [dropped] }, `${KB}/Skills`);
  });

  it('cannot be dragged away — a reserved root stays where the platform put it', () => {
    renderTree('/skills-and-tools');
    expect(row('Skills').closest('[draggable]')).toHaveAttribute('draggable', 'false');
    expect(row('Engineering').closest('[draggable]')).toHaveAttribute('draggable', 'true');
  });

  it("opens the folder's menu on the root row, minus what a reserved root must not do", () => {
    renderTree('/skills-and-tools');
    fireEvent.contextMenu(row('Skills'));
    const menu = screen.getByRole('menu', { name: 'Actions for Skills' });
    expect(within(menu).getByRole('menuitem', { name: /New folder/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Manage access/ })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /Rename/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /Delete/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /Pin/ })).not.toBeInTheDocument();
  });

  it('hands focus back to the root row when its menu closes on Escape', () => {
    renderTree('/skills-and-tools');
    fireEvent.contextMenu(row('Skills'));
    screen.getByRole('menu', { name: 'Actions for Skills' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Actions for Skills' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(row('Skills'));
  });

  it('keeps a right-click anywhere in the section from reaching the nav behind it', () => {
    const onNav = vi.fn();
    const workspace = makeWorkspaceFixture({ fileTree: TREE, kbDirName: KB });
    render(
      <MemoryRouter initialEntries={['/skills-and-tools']}>
        <WorkspaceContext.Provider value={workspace}>
          <div onContextMenu={onNav}>
            <SkillsTree />
          </div>
        </WorkspaceContext.Provider>
      </MemoryRouter>,
    );
    fireEvent.contextMenu(row('Skills'));
    fireEvent.contextMenu(screen.getByTestId('skills-tree'));
    expect(onNav).not.toHaveBeenCalled();
  });

  it("the root row's New folder button creates a scope directly under the root", () => {
    const createDirectory = vi.fn().mockResolvedValue(undefined);
    renderTree('/skills-and-tools', { createDirectory });
    fireEvent.click(screen.getByRole('button', { name: 'New folder in Skills' }));
    const input = screen.getByPlaceholderText('folder name');
    fireEvent.change(input, { target: { value: 'Marketing' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(createDirectory).toHaveBeenCalledWith(`${KB}/Skills/Marketing`);
  });
});

/**
 * The same tree, holding the OTHER root: `Plugins/` exactly as it is on disk,
 * manifests and all. One component, one set of rows; what differs is the
 * folder it is handed.
 */
describe('PluginsTree', () => {
  const PLUGINS: FileTreeEntry = dir('.', [
    dir(KB, [
      dir(`${KB}/Plugins`, [
        dir(`${KB}/Plugins/GTM`, [
          file(`${KB}/Plugins/GTM/plugin.json`),
          file(`${KB}/Plugins/GTM/mcp.json`),
          dir(`${KB}/Plugins/GTM/skills`, [
            dir(`${KB}/Plugins/GTM/skills/outreach`, [file(`${KB}/Plugins/GTM/skills/outreach/SKILL.md`)]),
          ]),
        ]),
        dir(`${KB}/Plugins/personal-u1`, [file(`${KB}/Plugins/personal-u1/plugin.json`)]),
      ]),
    ]),
  ]);

  function renderPlugins(url: string, over: Partial<WorkspaceContextValue> = {}) {
    const workspace = makeWorkspaceFixture({ fileTree: PLUGINS, kbDirName: KB, ...over });
    return render(
      <MemoryRouter initialEntries={[url]}>
        <WorkspaceContext.Provider value={workspace}>
          <PluginsTree />
          <LocationProbe />
        </WorkspaceContext.Provider>
      </MemoryRouter>,
    );
  }

  it('draws the Plugins root as a reserved folder row, its plugins collapsed under it', () => {
    renderPlugins('/skills-and-tools');
    expect(screen.getByTestId('plugins-tree')).toBeInTheDocument();
    expect(row('Plugins')).toHaveAttribute('aria-expanded', 'true');
    expect(row('Plugins').closest('[draggable]')).toHaveAttribute('draggable', 'false');
    expect(row('GTM')).toBeInTheDocument();
    expect(row('personal-u1')).toBeInTheDocument();
    expect(screen.queryByText('plugin.json')).not.toBeInTheDocument();
  });

  it("opens a plugin's files at their canonical default-branch URL — the item route decides the page", () => {
    renderPlugins('/skills-and-tools');
    fireEvent.click(row('GTM'));
    fireEvent.click(row('plugin.json'));
    expect(screen.getByLabelText('pathname')).toHaveTextContent(
      `/workspace/${DEFAULT_BRANCH}/${KB}/Plugins/GTM/plugin.json`,
    );
  });

  it('draws the folder even when the knowledge base has none yet', () => {
    const none = dir('.', [dir(KB, [dir(`${KB}/KnowledgeBase`, [])])]);
    renderPlugins('/skills-and-tools', { fileTree: none });
    expect(row('Plugins')).toBeInTheDocument();
    expect(row('Plugins')).not.toHaveAttribute('aria-expanded');
  });
});
