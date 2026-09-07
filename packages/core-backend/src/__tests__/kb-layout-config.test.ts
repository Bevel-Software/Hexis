import { describe, test, expect, afterEach } from 'vitest';
import {
  DEFAULT_KB_LAYOUT,
  KNOWLEDGE_BASE_DIR,
  PLUGINS_DIR,
  SKILLS_DIR,
  configureKbLayout,
  currentKbLayout,
  ontologyRoots,
  pluginOfPath,
  renderKbLayoutPlaceholders,
  reservedRootDirNames,
  validateKbLayout,
  validateKbRootName,
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
    expect(validateKbRootName('Skills')).toBeNull();
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
    expect(currentKbLayout()).toEqual({ knowledgeBaseDir: 'docs', skillsDir: 'skills', pluginsDir: 'plugins' });
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
