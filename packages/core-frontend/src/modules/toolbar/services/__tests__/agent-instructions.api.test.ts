import { describe, expect, it } from 'vitest';
import {
  editableDescriptionFromSource,
  mergeEditableDescription,
} from '../agent-instructions.api';

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
