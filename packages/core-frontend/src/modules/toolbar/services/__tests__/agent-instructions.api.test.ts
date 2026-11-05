import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import {
  editableDescriptionFromSource,
  fetchEditableAgentDescription,
  mergeEditableDescription,
  saveAgentDescription,
} from '../agent-instructions.api';
import { WorkspaceApiError } from '../../../workspace/services/workspace.api';

const { getOrCreateWorkspaceMock, readFileMock, writeFileMock } = vi.hoisted(() => ({
  getOrCreateWorkspaceMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock('../../../workspace/services/workspace.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../workspace/services/workspace.api')>()),
  getOrCreateWorkspace: getOrCreateWorkspaceMock,
  readFile: readFileMock,
  writeFile: writeFileMock,
}));

describe('inline agent-description source handling', () => {
  it('shows only the agent-visible text in the editor', () => {
    expect(
      editableDescriptionFromSource(
        '<!-- private starter notes -->\r\nAcme builds solar farms.<!-- private reminder -->\r\n\r\nCheck Projects/.',
      ),
    ).toBe('Acme builds solar farms.\n\nCheck Projects/.');
  });

  it('retains private comments while replacing the public description', () => {
    const source = '<!-- starter notes -->\nOld public text.\n<!-- private reminder -->\n';
    expect(mergeEditableDescription(source, 'New public text.')).toBe(
      '<!-- starter notes -->\n\n<!-- private reminder -->\n\nNew public text.\n',
    );
  });

  it('closes an unterminated private comment before the new public text', () => {
    const source = 'Old public text.\n<!-- private note without a closer';
    expect(mergeEditableDescription(source, 'New public text.')).toBe(
      '<!-- private note without a closer\n-->\n\nNew public text.\n',
    );
  });

  it('can clear the public description without deleting private comments', () => {
    expect(mergeEditableDescription('Visible.<!-- keep me -->', '   ')).toBe('<!-- keep me -->\n');
  });
});

describe('loading the editable description', () => {
  beforeEach(() => {
    getOrCreateWorkspaceMock.mockReset();
    getOrCreateWorkspaceMock.mockResolvedValue({ workspace: { id: DEFAULT_BRANCH } });
    readFileMock.mockReset();
    writeFileMock.mockReset();
    writeFileMock.mockResolvedValue(undefined);
  });

  it('opens empty when the file is not there yet', async () => {
    readFileMock.mockRejectedValue(new WorkspaceApiError(404, 'File not found'));

    await expect(fetchEditableAgentDescription('knowledge-base')).resolves.toEqual({
      workspaceId: DEFAULT_BRANCH,
      source: '',
      description: '',
    });
  });

  it('surfaces a read failure rather than opening an empty editor over text it could not read', async () => {
    readFileMock.mockRejectedValue(new WorkspaceApiError(500, 'permission denied'));

    await expect(fetchEditableAgentDescription('knowledge-base')).rejects.toMatchObject({ status: 500 });
  });

  it('saves the merged file conditionally on the bytes it loaded', async () => {
    const source = '<!-- private note -->\nOld public text.\n';

    await saveAgentDescription(DEFAULT_BRANCH, 'knowledge-base', source, 'New public text.');

    expect(writeFileMock).toHaveBeenCalledWith(
      DEFAULT_BRANCH,
      'knowledge-base/mcp-description.md',
      '<!-- private note -->\n\nNew public text.\n',
      { ifMatch: source },
    );
  });
});
