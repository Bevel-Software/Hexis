/**
 * Every spelling of a path INSIDE a repository's git folder, `<kb>/.git/<name>`,
 * that the git-folder security suites refuse through every door (the
 * workspace's in `workspace/__tests__/git-internals.security.test.ts`, the
 * diff module's in `diff/__tests__/git-internals.security.test.ts`). One
 * catalogue, so a family added here is asked of both suites' doors.
 *
 * The `symlinked` forms go through links the suites seed: `<kb>/gitlink ->
 * .git`, `<kb>/chained -> gitlink`, and `..link` in the workspace root
 * pointing at `<kb>/.git`. The absolute forms carry a `{{WORKSPACE_DIR}}`
 * placeholder, which a suite replaces once its temp root exists.
 */
export function gitFolderFileSpellings(kb: string, name: string): Record<string, string> {
  return {
    plain: `${kb}/.git/${name}`,
    'leading slash': `/${kb}/.git/${name}`,
    dotted: `${kb}/Notes/../.git/${name}`,
    'dot segments': `./${kb}/./.git/${name}`,
    // The five families production measured answering the path rule's 400
    // instead of this rule's 403 (parent-climb, dot-segment, backslash,
    // climb-out, absolute). `dotted`, `dot segments` and `backslashed` above
    // are three of them; these are the two the set was missing.
    'climb-out': `../${kb}/.git/${name}`,
    // Production's own spelling, kept verbatim: it names a directory that
    // exists on no test machine, so it is the LEXICAL half this covers.
    absolute: `/app/apps/server/workspaces/main/${kb}/.git/${name}`,
    // The same family pointed at this run's workspace, so the resolved half
    // is exercised too — the folder it names is really there.
    'absolute, in workspace': `{{WORKSPACE_DIR}}/${kb}/.git/${name}`,
    encoded: `${kb}/%2egit/${name}`,
    'double-encoded': `${kb}/%252Egit/${name}`,
    'upper-case': `${kb}/.GIT/${name}`,
    'mixed-case': `${kb}/.Git/${name}`,
    backslashed: `${kb}\\.git\\${name}`,
    symlinked: `${kb}/gitlink/${name}`,
    // A LINK into the folder, reached through each of those same five
    // spellings. Nothing in these names is `.git`, so only the resolved half
    // of the rule sees them — and while that half ran after the normaliser,
    // every one of them was answered by the path rule instead. This is the
    // shape that has now broken twice; it is spelled out per family so a
    // failure names the one that regressed.
    'symlinked, parent-climb': `${kb}/Notes/../gitlink/${name}`,
    'symlinked, dot segments': `./${kb}/./gitlink/${name}`,
    'symlinked, backslashed': `${kb}\\gitlink\\${name}`,
    'symlinked, climb-out': `../${kb}/gitlink/${name}`,
    'symlinked, absolute': `{{WORKSPACE_DIR}}/${kb}/gitlink/${name}`,
    'symlinked, chained link': `${kb}/Notes/../chained/${name}`,
    // A link named `..link` sitting in the WORKSPACE root: relative to the
    // root this rule judges against, the spelling begins with `..`, which is
    // the one shape a `startsWith('..')` climb test swallows. Spelled from
    // anywhere else (`knowledge-base/..link/…`) it never begins with `..` and
    // pins nothing.
    'symlinked, dotted name at the root': `..link/${name}`,
  };
}
