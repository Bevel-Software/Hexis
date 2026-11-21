/** A readable fallback when a UTCP tool has only its protocol identifier. */
export function toolTitle(name: string): string {
  const words = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}
