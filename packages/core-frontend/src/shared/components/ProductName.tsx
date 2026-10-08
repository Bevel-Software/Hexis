/** The product's own name, before its maker's: the first half of {@link PRODUCT_NAME}. */
const PRODUCT = 'Hexis';

/** The maker's name: the second half of {@link PRODUCT_NAME}, and the linked part of {@link ProductName}. */
const MAKER = 'Bevel';

/**
 * The product's name, as text: where a link cannot go, such as inside a
 * button or another interactive control. A heading is not such a place — a
 * link inside one is fine, so a title uses {@link ProductName}.
 */
export const PRODUCT_NAME = `${PRODUCT} by ${MAKER}`;

/** Where the maker's name leads. */
export const MAKER_URL = 'https://bevel.software';

/**
 * The product's name wherever it is shown: "Hexis by Bevel", with the maker's
 * name a link to its site.
 *
 * One component rather than the words at each call site, because the name
 * used to differ by screen ("Bevel" in the toolbar and on the login page,
 * "Hexis" elsewhere) and every copy is a place it can drift again. Both forms
 * are built from the same two names, so the linked one cannot fall out of
 * step with {@link PRODUCT_NAME}. A caller that sits inside a control, where
 * a nested link is not allowed, passes `link={false}` or uses
 * {@link PRODUCT_NAME}.
 */
export function ProductName({ link = true, className }: { link?: boolean; className?: string }) {
  return (
    <span className={className}>
      {PRODUCT} by{' '}
      {link ? (
        <a href={MAKER_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
          {MAKER}
        </a>
      ) : (
        MAKER
      )}
    </span>
  );
}
