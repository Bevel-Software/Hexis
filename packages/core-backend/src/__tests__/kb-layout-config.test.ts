import { describe, test, expect, afterEach } from 'vitest';
import {
  AGENTS_FILE,
  DEFAULT_KB_LAYOUT,
  KNOWLEDGE_BASE_DIR,
  PLUGINS_DIR,
  SKILLS_DIR,
  agentsFilePointerSentence,
  configureKbLayout,
  currentKbLayout,
  isPlatformFile,
  mentionsAgentsFile,
  ontologyRoots,
  platformFileNames,
  pluginOfPath,
  renderKbLayoutPlaceholders,
  reservedRootDirNames,
  validateAgentsFileName,
  validateKbLayout,
  validateKbRootName,
  normalizeSkillRoot,
} from '@bevel-software/platform-shared';

/**
 * The KB layout is module state shared by every test in the process, so each
 * test that reconfigures it puts the defaults back — exactly what a deployment
 * that names nothing runs with.
 */
afterEach(() => configureKbLayout({ ...DEFAULT_KB_LAYOUT }));

describe('KB layout — validation', () => {
  test('accepts the defaults and any three distinct plain folder names', () => {
    expect(validateKbLayout({ ...DEFAULT_KB_LAYOUT })).toBeNull();
    expect(
      validateKbLayout({ knowledgeBaseDir: 'docs', skillsDir: 'skills', pluginsDir: 'plugins' }),
    ).toBeNull();
  });

  test('refuses a root that could escape the repository or hide from the scanners', () => {
    expect(validateKbRootName('')).not.toBeNull();
    expect(validateKbRootName('a/b')).not.toBeNull();
    expect(validateKbRootName('a\\b')).not.toBeNull();
    expect(validateKbRootName('..')).not.toBeNull();
    expect(validateKbRootName('.git')).not.toBeNull();
    expect(validateKbRootName('.hidden')).not.toBeNull();
    expect(validateKbRootName('bad\nname')).not.toBeNull();
    // The same rule every file and folder name passes: reserved Windows
    // names, forbidden characters, trailing dots and spaces.
    expect(validateKbRootName('CON')).not.toBeNull();
    expect(validateKbRootName('a\u007fb')).not.toBeNull();
    expect(validateKbRootName('a:b')).not.toBeNull();
    expect(validateKbRootName('name.')).not.toBeNull();
    expect(validateKbRootName('x'.repeat(300))).not.toBeNull();
    expect(validateKbRootName('Skills')).toBeNull();
    expect(validateKbRootName('My Skills')).toBeNull();
  });

  test('a skill root forgives trailing slashes only — an empty segment inside is malformed', () => {
    expect(normalizeSkillRoot('Skills/Eng/deploy/')).toBe('Skills/Eng/deploy');
    expect(normalizeSkillRoot('Skills/Eng/deploy//')).toBe('Skills/Eng/deploy');
    expect(normalizeSkillRoot('Skills//deploy')).toBeNull();
    expect(normalizeSkillRoot('Skills/./deploy')).toBeNull();
    expect(normalizeSkillRoot('/Skills/deploy')).toBeNull();
  });

  test('refuses a configurable root that takes a fixed reserved name', () => {
    expect(
      validateKbLayout({ knowledgeBaseDir: 'KnowledgeBase', skillsDir: 'data', pluginsDir: 'Plugins' }),
    ).toMatch(/reserved folder name/);
  });

  test('renders placeholders without interpreting $-patterns in a folder name', () => {
    expect(
      renderKbLayoutPlaceholders('a {{skillsDir}} b', { knowledgeBaseDir: 'K', skillsDir: 'Sales$&', pluginsDir: 'P' }),
    ).toBe('a Sales$& b');
    expect(renderKbLayoutPlaceholders('no placeholders', DEFAULT_KB_LAYOUT)).toBe('no placeholders');
  });

  test('refuses two roots sharing a name, case-insensitively — one folder on a case-insensitive disk', () => {
    expect(
      validateKbLayout({ knowledgeBaseDir: 'KnowledgeBase', skillsDir: 'skills', pluginsDir: 'Skills' }),
    ).toMatch(/three different names/);
  });
});

describe('KB layout — configuration', () => {
  test('applies the names to the live bindings every consumer reads', () => {
    configureKbLayout({ knowledgeBaseDir: 'docs', skillsDir: 'skills', pluginsDir: 'plugins' });
    expect(KNOWLEDGE_BASE_DIR).toBe('docs');
    expect(SKILLS_DIR).toBe('skills');
    expect(PLUGINS_DIR).toBe('plugins');
    expect(currentKbLayout()).toEqual({
      knowledgeBaseDir: 'docs',
      skillsDir: 'skills',
      pluginsDir: 'plugins',
      agentsFile: 'AGENTS.md',
    });
  });

  test('the derived sets follow the configured names rather than snapshotting the defaults', () => {
    configureKbLayout({ knowledgeBaseDir: 'docs', skillsDir: 'skills', pluginsDir: 'plugins' });
    expect(ontologyRoots()).toEqual(['docs', 'Data']);
    expect(reservedRootDirNames().has('plugins')).toBe(true);
    expect(reservedRootDirNames().has('Plugins')).toBe(false);
    // Path rules read the live name too.
    expect(pluginOfPath('plugins/GTM/skills/x/SKILL.md')).toBe('GTM');
    expect(pluginOfPath('Plugins/GTM/skills/x/SKILL.md')).toBeNull();
  });

  test('throws on an invalid layout and leaves the current one untouched', () => {
    expect(() =>
      configureKbLayout({ knowledgeBaseDir: 'a', skillsDir: 'a', pluginsDir: 'b' }),
    ).toThrow(/three different names/);
    expect(currentKbLayout()).toEqual(DEFAULT_KB_LAYOUT);
  });

  test('trims what it applies', () => {
    configureKbLayout({ knowledgeBaseDir: ' docs ', skillsDir: 'skills', pluginsDir: 'plugins' });
    expect(KNOWLEDGE_BASE_DIR).toBe('docs');
  });
});

/**
 * The agent guide's file name — the fourth thing a deployment may name. The
 * default is what every deployment before this change ran with, so the
 * default-name tests here are the regression net for all of them.
 */
describe('KB layout — the agent guide\'s file name', () => {
  test('defaults to AGENTS.md, and a layout that names no guide is the default layout', () => {
    expect(AGENTS_FILE).toBe('AGENTS.md');
    expect(DEFAULT_KB_LAYOUT.agentsFile).toBe('AGENTS.md');
    // An older server's /api/config body, and a deployment that saved three
    // folder names before the setting existed, both look like this.
    configureKbLayout({ knowledgeBaseDir: 'docs', skillsDir: 'skills', pluginsDir: 'plugins' });
    expect(AGENTS_FILE).toBe('AGENTS.md');
  });

  test('accepts a plain markdown name and applies it to the live binding', () => {
    expect(validateAgentsFileName('HEXIS.md')).toBeNull();
    configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    expect(AGENTS_FILE).toBe('HEXIS.md');
    expect(currentKbLayout().agentsFile).toBe('HEXIS.md');
  });

  test('refuses every shape that is not one markdown file name of its own', () => {
    // A folder path: the guide is read from the repository root and nowhere else.
    expect(validateAgentsFileName('guides/HEXIS.md')).toMatch(/single file name/);
    expect(validateAgentsFileName('guides\\HEXIS.md')).toMatch(/single file name/);
    // Not markdown: the per-file access rules apply to `.md` alone.
    expect(validateAgentsFileName('HEXIS.txt')).toMatch(/end in \.md/);
    // Nothing at all.
    expect(validateAgentsFileName('')).toMatch(/required/);
    expect(validateAgentsFileName('   ')).toMatch(/required/);
    // A dot-file every scanner skips — including the one that draws the tree.
    expect(validateAgentsFileName('.hidden.md')).toMatch(/start with a dot/);
    // The guide's own pre-rename name stays legacy content.
    expect(validateAgentsFileName('CLAUDE.md')).toMatch(/pre-rename name/);
    expect(validateAgentsFileName('claude.md')).toMatch(/pre-rename name/);
    // The other platform files: two platform roles on one path.
    expect(validateAgentsFileName('access.md')).toMatch(/platform file name/);
    expect(validateAgentsFileName('roles.yaml')).toMatch(/platform file name/);
    expect(validateAgentsFileName('.bevelignore')).toMatch(/platform file name/);
    expect(validateAgentsFileName('mcp-description.md')).toMatch(/platform file name/);
    // The rule every path component passes.
    expect(validateAgentsFileName('CON.md')).not.toBeNull();
    expect(validateAgentsFileName('a:b.md')).not.toBeNull();
  });

  test('refuses the name of a root folder, whichever of the two the save names', () => {
    expect(validateAgentsFileName('Plugins.md', { ...DEFAULT_KB_LAYOUT, pluginsDir: 'Plugins.md' }))
      .toMatch(/already the plugins folder/);
    // Case-insensitively, like the folders are to each other: one entry on a
    // case-insensitive disk.
    expect(validateKbLayout({ ...DEFAULT_KB_LAYOUT, skillsDir: 'guide.md', agentsFile: 'GUIDE.md' }))
      .toMatch(/already the skills folder/);
    // And the whole-layout check says which field it is about.
    expect(validateKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.txt' }))
      .toMatch(/agent guide's file name/);
  });

  test('renders {{agentsFile}} so the written guide names the file it lives in', () => {
    expect(
      renderKbLayoutPlaceholders('see {{agentsFile}}', { ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' }),
    ).toBe('see HEXIS.md');
    // A `$`-pattern in the name is a name, not a replacement pattern.
    expect(
      renderKbLayoutPlaceholders('{{agentsFile}}', { ...DEFAULT_KB_LAYOUT, agentsFile: 'A$&.md' }),
    ).toBe('A$&.md');
    expect(renderKbLayoutPlaceholders('see {{agentsFile}}', DEFAULT_KB_LAYOUT)).toBe('see AGENTS.md');
  });

  test('the platform-file gate follows the name: ours is managed, theirs is content', () => {
    expect(platformFileNames(DEFAULT_KB_LAYOUT)).toEqual([
      'access.md',
      'roles.yaml',
      '.bevelignore',
      'AGENTS.md',
    ]);
    expect(isPlatformFile('AGENTS.md')).toBe(true);

    configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    expect(platformFileNames()).toEqual(['access.md', 'roles.yaml', '.bevelignore', 'HEXIS.md']);
    // The guide the platform writes is immovable and undeletable…
    expect(isPlatformFile('HEXIS.md')).toBe(true);
    // …and the customer's own AGENTS.md is a page like any other.
    expect(isPlatformFile('AGENTS.md')).toBe(false);
    // Still root-only, as `roles.yaml` is: a nested copy is content.
    expect(isPlatformFile('KnowledgeBase/HEXIS.md')).toBe(false);
  });

  test('the pointer sentence is one sentence, naming the guide twice, from one place', () => {
    expect(agentsFilePointerSentence('HEXIS.md')).toBe(
      'Read [HEXIS.md](./HEXIS.md) before working in this knowledge base — ' +
        "it is the platform's guide to its layout, files and rules.",
    );
    configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    expect(agentsFilePointerSentence()).toContain('HEXIS.md');
  });

  /**
   * A guide name is a FILE NAME: spaces, brackets, parentheses, `#` and `%`
   * all pass `validateFilename`, and every one of them means something in an
   * inline link. The label must not end early and the destination must still
   * point at the file.
   */
  test('the pointer sentence links correctly for a name full of markdown punctuation', () => {
    const name = 'Our [Agent] Guide (v2).md';
    expect(validateAgentsFileName(name)).toBeNull();
    const sentence = agentsFilePointerSentence(name);
    // The label cannot end early: the brackets in it are escaped…
    expect(sentence).toContain('[Our \\[Agent\\] Guide (v2).md]');
    // …and the destination is percent-encoded, parentheses included — a bare
    // `)` would close the link half way through the name.
    expect(sentence).toContain('(./Our%20%5BAgent%5D%20Guide%20%28v2%29.md)');
    // The ordinary name reads as it always has — no escapes, nothing encoded.
    expect(agentsFilePointerSentence('AGENTS.md')).toContain('[AGENTS.md](./AGENTS.md)');
  });

  test('the pointer sentence encodes a name that would otherwise open a URL fragment', () => {
    // `#` is legal in a filename and opens a fragment in a URL: `./#2 Guide.md`
    // links to the customer's OWN file with a fragment, not to the guide.
    expect(validateAgentsFileName('#2 Guide.md')).toBeNull();
    expect(agentsFilePointerSentence('#2 Guide.md')).toContain('(./%232%20Guide.md)');
    // `%` is legal too, and an unencoded one is a malformed escape.
    expect(agentsFilePointerSentence('100%.md')).toContain('(./100%25.md)');
  });

  /**
   * The startup step asks this before appending, and it has to recognise the
   * sentence the LAST boot wrote — whose spelling of the name is escaped in
   * the label and encoded in the destination. Asking for the raw name alone
   * would append a second copy on every boot after the first.
   */
  test('a file already carrying the pointer sentence counts as mentioning the guide', () => {
    for (const name of ['AGENTS.md', 'Our [Agent] Guide (v2).md', '#2 Guide.md', '100%.md']) {
      const appended = `# Acme\n\n${agentsFilePointerSentence(name)}\n`;
      expect(mentionsAgentsFile(appended, name), name).toBe(true);
    }
    // A file that says nothing about the guide still reads as silent…
    expect(mentionsAgentsFile('# Acme\n\nWrite tickets in the present tense.\n', 'HEXIS.md')).toBe(false);
    // …and the customer's own plain mention counts, in their own words.
    expect(mentionsAgentsFile('See HEXIS.md for the platform.', 'HEXIS.md')).toBe(true);
  });
});
