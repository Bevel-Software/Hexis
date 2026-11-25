import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminContext, type AdminContextValue } from '../../../admin';
import { AppRegistryContext, EMPTY_REGISTRY, type AppRegistry } from '../../../../core/registry';
import { DeploymentPage } from '../DeploymentPage';

/**
 * Where "What agents are told" sits on Deployment: it is a workspace setting,
 * so it is core's last section, below the settings form, and a distribution's
 * panel keeps the last place on the page under it.
 *
 * Driven at the network layer, not through the setup or toolbar modules'
 * files: the page asks for its status and the card for its instructions the
 * way they do in the app, and anything else they ask is answered 404.
 */

const { authFetchMock } = vi.hoisted(() => ({
  authFetchMock: vi.fn(async (url: string) => {
    if (url === '/api/setup/status') return json(COMPLETE_STATUS);
    if (url === '/api/agent/instructions') return json(INSTRUCTIONS);
    return new Response('{}', { status: 404 });
  }),
}));
vi.mock('../../../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/api')>()),
  authFetch: authFetchMock,
}));

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** A settled status: setup is complete, which is when this page exists. */
const COMPLETE_STATUS = {
  complete: true,
  awaitingRestart: false,
  isAdmin: true,
  settings: [
    { key: 'kbRepoUrl', section: 'knowledge-base', source: 'saved', value: 'https://git.example.com/kb.git' },
    { key: 'oidcIssuerUrl', section: 'sign-in', source: 'saved', value: '' },
    { key: 'oidcClientId', section: 'sign-in', source: 'saved', value: '' },
    { key: 'oidcClientSecret', section: 'sign-in', source: 'saved', value: '' },
  ],
};

const INSTRUCTIONS = {
  instructions: 'Search the knowledge base first.',
  header: 'Search the knowledge base first.',
  preamble: '',
  toolPrefix: 'Search it before answering from memory.',
  toolPrefixLine: 'Search it before answering from memory.',
  truncated: false,
  preambleChars: 0,
  toolPrefixTruncated: false,
  toolPrefixChars: 40,
  unterminatedComment: false,
};

/** What a distribution would put at the foot of the page. */
function WorkspacePanel() {
  return <section aria-label="Workspace">Delete this workspace</section>;
}
const WITH_PANEL: AppRegistry = { ...EMPTY_REGISTRY, deploymentPanel: WorkspacePanel };

describe('DeploymentPage: What agents are told', () => {
  it('is core’s last section, after the form, with the distribution panel under it', async () => {
    render(
      <AppRegistryContext.Provider value={WITH_PANEL}>
        <AdminContext.Provider value={{ isAdmin: true } as AdminContextValue}>
          <DeploymentPage />
        </AdminContext.Provider>
      </AppRegistryContext.Provider>,
    );
    const save = await screen.findByRole('button', { name: 'Save and continue' });
    const told = await screen.findByRole('heading', { name: 'What agents are told' });
    const panel = await screen.findByRole('region', { name: 'Workspace' });
    expect(save.compareDocumentPosition(told) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(told.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
