import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AdminContext } from '../../admin/state/admin.context';
import type { LibraryData } from '../hooks/useLibraryData';

/**
 * The public-demo lockdown's face: "New plugin" answers with the
 * self-host-it dialog instead of the create form. The endpoint refusal is the
 * backend's test (plugins.routes.test.ts); this one proves a visitor is TOLD,
 * not just refused.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));

vi.mock('../services/plugins.api', () => ({
  listPlugins: vi.fn().mockResolvedValue([]),
  listJoinRequests: vi.fn().mockResolvedValue([]),
}));

const bootstrapMock = vi.hoisted(() => ({ isPublicDemo: vi.fn() }));
vi.mock('../../../core/bootstrap', () => ({ isPublicDemo: bootstrapMock.isPublicDemo }));

import { LibraryRoutes } from '../routes/LibraryRoutes';
import { withAuth } from './auth-harness';

const CATALOG: LibraryData = {
  loading: false,
  error: null,
  skills: [],
  pendingSkills: [],
  tools: [],
  ownedSkills: new Set<string>(),
  allowedToolsBySkill: new Map(),
  crs: [],
  myCrNumbers: new Set<number>(),
  reload: vi.fn(),
};

function wrap(children: ReactNode) {
  const adminValue = {
    isAdmin: false,
    unreadCount: 0,
    lastSeen: null,
    markSeen: vi.fn(),
    refresh: vi.fn(),
    rolesConfigCorrupted: false,
    rolesConfigErrors: [],
    runRolesRecovery: vi.fn(),
  };
  const workspaceValue = {
    workspaceId: 'ws',
    kbDirName: 'knowledge-base',
  } as unknown as WorkspaceContextValue;
  return (
    <AdminContext.Provider value={adminValue}>
      <WorkspaceContext.Provider value={workspaceValue}>
        {withAuth(children)}
      </WorkspaceContext.Provider>
    </AdminContext.Provider>
  );
}

function renderLibrary() {
  return render(
    <MemoryRouter initialEntries={['/skills-and-tools']}>
      {wrap(
        <Routes>
          <Route path="/skills-and-tools/*" element={<LibraryRoutes />} />
        </Routes>,
      )}
    </MemoryRouter>,
  );
}

beforeEach(() => {
  dataMock.useLibraryData.mockReturnValue(CATALOG);
});

describe('public-demo lockdown', () => {
  it('New plugin opens the self-host dialog instead of the create form', async () => {
    bootstrapMock.isPublicDemo.mockReturnValue(true);
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'New plugin' }));

    expect(await screen.findByText('Not in this demo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get your own on GitHub' })).toBeInTheDocument();
    // The create form never mounts — there is nothing to fill in.
    expect(screen.queryByLabelText('Plugin name')).toBeNull();
  });

  it('outside the demo, New plugin still opens the create form', async () => {
    bootstrapMock.isPublicDemo.mockReturnValue(false);
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'New plugin' }));

    expect(await screen.findByLabelText('Plugin name')).toBeInTheDocument();
    expect(screen.queryByText('Not in this demo')).toBeNull();
  });
});
