/** The product's name, as text: where a link cannot go, such as inside a button or a page title. */
export const PRODUCT_NAME = 'Hexis by Bevel';

/** Where the maker's name leads. */
export const MAKER_URL = 'https://bevel.software';

/**
 * The product's name wherever it is shown: "Hexis by Bevel", with the maker's
 * name a link to its site.
 *
 * One component rather than the words at each call site, because the name
 * used to differ by screen ("Bevel" in the toolbar and on the login page,
 * "Hexis" elsewhere) and every copy is a place it can drift again. A caller
 * that sits inside a control, where a nested link is not allowed, passes
 * `link={false}` or uses {@link PRODUCT_NAME}.
 */
export function ProductName({ link = true, className }: { link?: boolean; className?: string }) {
  return (
    <span className={className}>
      Hexis by{' '}
      {link ? (
        <a href={MAKER_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
          Bevel
        </a>
      ) : (
        'Bevel'
      )}
    </span>
  );
}
