/**
 * How long a toast stays up.
 *
 * A flat 2.6s was chosen when the only toast said "Copied", and never
 * revisited — so the onboarding confirmation, at 76 characters, was gone
 * before it could be read. Reading time is roughly linear in length, so this
 * is too: floored so a short message does not blink, capped so a long one
 * cannot camp on the screen.
 *
 * Its own module rather than a second export from `state/toast.tsx`, because
 * a component file that also exports a plain function breaks fast refresh for
 * everything in it.
 */
export function toastDuration(message: string): number {
  return Math.min(9000, Math.max(3000, 1400 + message.length * 55));
}
