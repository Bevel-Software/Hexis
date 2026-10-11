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
