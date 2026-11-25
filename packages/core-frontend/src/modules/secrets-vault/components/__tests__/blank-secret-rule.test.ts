import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isBlankSecret } from '@bevel-software/platform-shared';

/**
 * Whether a typed key or client secret is blank has one answer,
 * `isBlankSecret` from the shared package: the secrets vault refuses by it,
 * and each form here that sends a key or a client secret asks it. The second
 * case reads the forms' source, so a form that decides blankness inline again
 * (the `!value.trim()` they each carried) fails here.
 */
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FORMS = [
  'modules/library/components/tool-page/ToolVarRow.tsx',
  'modules/secrets-vault/components/ToolSecretsPanel.tsx',
  'modules/secrets-vault/components/ConnectToolsPage.tsx',
  'modules/secrets-vault/components/ManagedConnectorCard.tsx',
  'modules/secrets-vault/components/SecretsPage.tsx',
];

describe('a blank key or client secret: one rule', () => {
  it('is blank when empty or only whitespace, and not otherwise', () => {
    for (const blank of ['', '   ', '\t\n ', '\u00A0\u2003']) expect(isBlankSecret(blank)).toBe(true);
    for (const real of ['k', ' k ', 'cs_live']) expect(isBlankSecret(real)).toBe(false);
  });

  it.each(FORMS)('%s asks isBlankSecret and decides no blank secret inline', (file) => {
    const source = readFileSync(join(SRC_DIR, file), 'utf8');
    expect(source).toMatch(/\bisBlankSecret\(/);
    expect(source).not.toMatch(/!\s*(value|secret|clientSecret)\.trim\(\)/);
    expect(source).not.toMatch(/\b(value|secret|clientSecret)\.trim\(\)\s*\|\|/);
  });
});
