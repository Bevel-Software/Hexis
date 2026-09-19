/**
 * What to do about a refused upload, from the server's own reason.
 *
 * The error banner ends with a next step because the reason alone leaves the
 * user holding a file and no idea where to put it — and the three classes of
 * refusal want three different answers. Lives here rather than beside the
 * banner so it can be read and tested without rendering a tree.
 */
export function uploadErrorNextStep(reason: string): string {
  if (/permission|not allowed|forbidden|unauthori[sz]ed|\b403\b/i.test(reason)) {
    return 'Try another folder or ask its owner.';
  }
  if (/too large|exceeds|size limit|byte limit|\b413\b/i.test(reason)) {
    return 'Files up to 50 MB — try a smaller one.';
  }
  return 'Try again, or pick another folder.';
}
