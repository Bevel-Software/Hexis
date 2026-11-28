import { describe, expect, it } from 'vitest';
import { changeRequestOutcomeMessage } from '../utils/change-request-outcome';

/**
 * The skill page's word on a request its whole-change dialog settled. The
 * dialog reports `applied` after a merge and `closed` when the request ended
 * with nothing merged (its last file declined, or the request deleted).
 */
describe('changeRequestOutcomeMessage', () => {
  it('says the request is being applied when the dialog applied it', () => {
    expect(changeRequestOutcomeMessage('applied')).toBe('Change request is being applied');
  });

  it('says nothing was changed when the dialog closed it without a merge, never that it is being applied', () => {
    const closed = changeRequestOutcomeMessage('closed');
    expect(closed).toBe('Change request closed. Nothing was changed.');
    expect(closed).not.toMatch(/appl/i);
  });
});
