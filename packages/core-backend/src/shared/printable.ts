/**
 * Re-export, so this backend's ~20 call sites keep their short import while
 * the function itself lives where BOTH MCP surfaces can reach it.
 *
 * The local server (`@bevel-software/hexis-mcp`) is published standalone and
 * cannot import this package, but it logs the same kind of text — a reason
 * string that came off the network — to the same kind of operator log. Two
 * copies of an escaper is two escapers that drift, so it moved to the one
 * package both already depend on. See `printable` there for what it escapes
 * and why.
 */
export { printable } from '@bevel-software/platform-mcp-core';
