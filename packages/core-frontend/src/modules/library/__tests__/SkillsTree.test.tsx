import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { DEFAULT_BRANCH, type FileTreeEntry } from '@bevel-software/platform-shared';
import { WorkspaceContext, type WorkspaceContextValue } from '../../workspace/state/workspace.context';
import { makeWorkspaceFixture } from '../../workspace/__tests__/testFixtures';
import { SkillsTree } from '../components/SkillsTree';

/**
 * The Skills section of the Library nav: the shared root as Knowledge's tree
 * rows, headed by a label instead of a root row, with the two things that
 * differ from Knowledge — where a click goes (the skill page, on the default
 * branch) and which row is current (the file the URL names).
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
  it('heads the scopes with a Skills label and draws no root row', () => {
    renderTree('/skills-and-tools');
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skills' })).not.toBeInTheDocument();
    // The scopes are the top level, collapsed until opened.
    expect(row('Engineering')).toBeInTheDocument();
    expect(row('Sales')).toBeInTheDocument();
    expect(screen.queryByText('deploy')).not.toBeInTheDocument();
    expect(screen.queryByText('discovery-call')).not.toBeInTheDocument();
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

  it('renders nothing when the tree has no Skills root — no heading over nothing', () => {
    const noSkills = dir('.', [dir(KB, [dir(`${KB}/KnowledgeBase`, [])])]);
    renderTree('/skills-and-tools', { fileTree: noSkills });
    expect(screen.queryByText('Skills')).not.toBeInTheDocument();
  });

  it("the label's New folder button creates a scope directly under the root", () => {
    const createDirectory = vi.fn().mockResolvedValue(undefined);
    renderTree('/skills-and-tools', { createDirectory });
    fireEvent.click(screen.getByRole('button', { name: 'New folder in Skills' }));
    const input = screen.getByPlaceholderText('folder name');
    fireEvent.change(input, { target: { value: 'Marketing' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(createDirectory).toHaveBeenCalledWith(`${KB}/Skills/Marketing`);
  });
});
