/**
 * What to do about a refused upload.
 *
 * The error banner ends with a next step because the reason alone leaves the
 * user holding a file and no idea where to put it — and the refusals that
 * have a specific answer want different ones.
 *
 * The HTTP STATUS decides, not the wording: the backend answers 403 for a
 * folder the caller may not write and 413 for a file over the upload cap, and
 * those two map one-to-one onto the two specific steps. Classifying on the
 * server's prose instead meant any rewording of a message — or a change to
 * the size cap the advice used to restate — silently started telling users
 * the wrong thing, with nothing failing to say so. The message is for the
 * banner's reason line and nothing else.
 *
 * `status` is absent for a failure that never reached an HTTP response (the
 * network, or the folder walker); "try again" is the honest step for those.
 *
 * Lives here rather than beside the banner so it can be read and tested
 * without rendering a tree.
 */
export function uploadErrorNextStep(status: number | undefined): string {
  if (status === 401 || status === 403) return 'Try another folder or ask its owner.';
  if (status === 413) return 'That file is over the upload size limit — try a smaller one.';
  return 'Try again, or pick another folder.';
}
