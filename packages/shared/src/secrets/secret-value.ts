/**
 * Whether a secret a person typed holds nothing: it is empty or only
 * whitespace as `String.prototype.trim` sees it (spaces, tabs, line breaks,
 * a no-break or an em space). The one answer to that question. The secrets
 * vault refuses such a value wherever it saves a key or a tool sign-in's
 * client secret (a 422, nothing stored), and the web app's secrets forms ask
 * it before they send one.
 */
export function isBlankSecret(value: string): boolean {
  return value.trim() === '';
}
