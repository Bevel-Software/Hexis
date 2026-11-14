/**
 * Where the maker's name in "Hexis by Bevel" leads. Its own module because
 * two components link the name, `ProductName` and the toolbar's app menu,
 * and a component's file exports components only (fast refresh).
 */

import { useAppRegistry } from './registry';

/** Where the maker's name leads when the registry names no other place (`makerLink` absent or empty). */
export const MAKER_URL = 'https://bevel.software';

/**
 * Where the maker's name leads in this deployment: the registry's
 * `makerLink`, absent or empty {@link MAKER_URL}. One place for the rule, so
 * the toolbar's menu, which links the name where its trigger cannot, leads
 * where `ProductName` does.
 */
export function useMakerUrl(): string {
  const { makerLink } = useAppRegistry();
  return makerLink || MAKER_URL;
}

/**
 * What the app menu's entry for that place says: the registry's
 * `makerLinkLabel`, absent or empty `fallback` (the product's name).
 */
export function useMakerLinkLabel(fallback: string): string {
  const { makerLinkLabel } = useAppRegistry();
  return makerLinkLabel?.trim() || fallback;
}
