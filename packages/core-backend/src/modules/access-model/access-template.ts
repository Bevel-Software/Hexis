/**
 * The shape of an `access.md` the platform writes on its own — THE one
 * explanation of how the file works, carried inside every file it generates
 * so a person (or an agent) reading it in place learns the rules from the
 * file itself, rather than from a document they have not opened.
 *
 * Two blocks, two scopes: the frontmatter governs the FILE, the body governs
 * the FOLDER. The wording here is what a fresh folder `access.md` carries
 * (`spliceGrant` on an empty file with `target: 'folder'`); the plugin and
 * personal-space templates in the provisioning service say the same thing in
 * their own words, tailored to what those folders are.
 */

/** The frontmatter block of a fresh access.md — comments only, no verbs. */
export const ACCESS_MD_FRONTMATTER_NOTE: readonly string[] = [
  '# THIS BLOCK (the frontmatter) governs this access.md FILE only: who may see',
  '# and change these rules. Left empty, the file follows the folder rules below.',
];

/** The comment block that opens a fresh access.md body, before its verbs. */
export const ACCESS_MD_BODY_NOTE: readonly string[] = [
  '# THIS BLOCK (the body) governs the FOLDER this file sits in, and everything',
  '# beneath it until a nearer access.md says otherwise. Verbs: read, write,',
  '# download, owner (owner implies the rest; write implies read). An entry is a',
  '# role from roles.yaml, a group from groups.yaml, a person as `Name <email>`,',
  '# or `everyone` — every signed-in person, the whole organisation. `deny X`',
  '# takes away. Keep this block pure YAML; explanations go in `#` lines.',
];

/**
 * A fresh access.md around `bodyYaml` (the folder's verbs, already rendered)
 * — the two blocks, each opened by its note.
 */
export function freshAccessMd(bodyYaml: string, eol = '\n'): string {
  return [
    '---',
    ...ACCESS_MD_FRONTMATTER_NOTE,
    '---',
    ...ACCESS_MD_BODY_NOTE,
    bodyYaml,
  ].join(eol) + eol;
}
