import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LibraryToastProvider } from '../state/toast';
import type { LibraryItem } from '../state/library-data';

/**
 * The link picker: offers what is not yet in the plugin, links on click, and
 * turns the server's "you may edit the plugin but not the skill" refusal into
 * the request path — never deciding that client-side.
 */

const api = vi.hoisted(() => ({
  linkSkill: vi.fn(),
  requestSkillAccess: vi.fn(),
}));
vi.mock('../services/plugins.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/plugins.api')>()),
  linkSkill: api.linkSkill,
}));
vi.mock('../services/library.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/library.api')>()),
  requestSkillAccess: api.requestSkillAccess,
}));

import { NeedsSkillWriteError } from '../services/plugins.api';
import { LinkSkillPanel } from '../components/LinkSkillPanel';

const OK = { state: 'ok' as const, text: 'Ready' };
const items: LibraryItem[] = [
  { kind: 'skill', id: 'deploy', name: 'deploy', description: 'Ship it.', owned: false, plugin: null, shared: true, plugins: [], path: 'Skills/Eng/deploy', status: OK },
  { kind: 'skill', id: 'outreach', name: 'outreach', description: '', owned: true, plugin: 'GTM', plugins: [{ name: 'GTM', linked: false, granted: true }], path: 'Plugins/GTM/skills/outreach', status: OK },
  { kind: 'skill', id: 'pitch', name: 'pitch', description: 'Sales pitch.', owned: false, plugin: 'Sales', plugins: [{ name: 'Sales', linked: false, granted: true }], path: 'Plugins/Sales/skills/pitch', status: OK },
  { kind: 'integration', id: 'notion', name: 'Notion', description: '', owned: false, plugin: 'GTM', path: 'Plugins/GTM/mcp.json', status: OK },
];

function renderPanel() {
  const onLinked = vi.fn();
  render(
    <LibraryToastProvider>
      <LinkSkillPanel plugin="GTM" items={items} onLinked={onLinked} />
    </LibraryToastProvider>,
  );
  return { onLinked };
}

beforeEach(() => {
  api.linkSkill.mockReset();
  api.requestSkillAccess.mockReset();
});

describe('LinkSkillPanel', () => {
  it('offers released skills not already in the plugin — never tools, never its own', () => {
    renderPanel();
    expect(screen.getByText('deploy')).toBeInTheDocument();
    expect(screen.getByText('pitch')).toBeInTheDocument();
    expect(screen.queryByText('outreach')).not.toBeInTheDocument();
    expect(screen.queryByText('Notion')).not.toBeInTheDocument();
  });

  it('narrows by the search box', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Search skills to link'), { target: { value: 'pit' } });
    expect(screen.queryByText('deploy')).not.toBeInTheDocument();
    expect(screen.getByText('pitch')).toBeInTheDocument();
  });

  it('links by the skill\'s path and reports back', async () => {
    api.linkSkill.mockResolvedValue({ root: 'Skills/Eng/deploy', skills: ['Skills/Eng/deploy'] });
    const { onLinked } = renderPanel();
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    await waitFor(() => expect(api.linkSkill).toHaveBeenCalledWith('GTM', 'Skills/Eng/deploy'));
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
  });

  it('turns the server\'s needs-skill-write refusal into a request, and says when it is sent', async () => {
    api.linkSkill.mockRejectedValue(new NeedsSkillWriteError('Skills/Eng/deploy'));
    api.requestSkillAccess.mockResolvedValue({ number: 7 });
    const { onLinked } = renderPanel();
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    const request = await screen.findByRole('button', { name: 'Request write access' });
    expect(onLinked).not.toHaveBeenCalled();
    fireEvent.click(request);
    await waitFor(() => expect(api.requestSkillAccess).toHaveBeenCalledWith('deploy'));
    expect(await screen.findByText('Requested')).toBeInTheDocument();
  });
});
