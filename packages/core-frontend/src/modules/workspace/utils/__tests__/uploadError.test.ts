import { describe, it, expect } from 'vitest';
import { uploadErrorNextStep } from '../uploadError';

/**
 * The banner's last line, pinned directly — it used to be reachable only by
 * rendering a tree, which is exactly the coupling that let the classifier
 * drift: the advice was picked by matching the backend's prose, so a reworded
 * refusal silently started telling the user the wrong thing and no test said
 * so. The status is the contract now.
 */
describe('uploadErrorNextStep', () => {
  it('sends a refused writer to another folder, or to the owner', () => {
    expect(uploadErrorNextStep(403)).toBe('Try another folder or ask its owner.');
  });

  it('sends a lapsed session back to sign in — another folder would refuse the same way', () => {
    expect(uploadErrorNextStep(401)).toBe('Sign in again, then try once more.');
  });

  it('asks for a smaller file when the upload was too big', () => {
    expect(uploadErrorNextStep(413)).toContain('try a smaller one');
  });

  it('does not restate the size cap, which lives in the backend', () => {
    // The old copy promised "Files up to 50 MB". The number is the
    // backend's (`MAX_UPLOAD_BYTES`), and a change there must not leave this
    // line quietly lying; the server's own reason carries the limit.
    expect(uploadErrorNextStep(413)).not.toMatch(/\d/);
  });

  it('says "try again" for anything else, including a failure with no response', () => {
    expect(uploadErrorNextStep(500)).toBe('Try again, or pick another folder.');
    expect(uploadErrorNextStep(undefined)).toBe('Try again, or pick another folder.');
  });
});
