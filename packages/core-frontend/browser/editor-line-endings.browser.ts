import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { build, type Rollup } from 'vite';

/**
 * A file saved from the app keeps its line endings, through a real textarea.
 *
 * What failed in QA: a CRLF file edited by one word in the file page's editor
 * was saved with every line rewritten to LF. A browser's `<textarea>` hands
 * its text back with LF line breaks whatever it was given; the unit suite's
 * DOM does not, so this is asked of Chromium, over the real editors on a
 * stand-in page that records what each would write.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

let pageBundle: string | undefined;
async function bundle(): Promise<string> {
  if (pageBundle) return pageBundle;
  const built = (await build({
    configFile: false,
    root: path.resolve(here, 'fixtures'),
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      minify: false,
      lib: { entry: path.resolve(here, 'fixtures/editor-line-endings-page.tsx'), formats: ['iife'], name: 'EditorLineEndingsPage', fileName: () => 'editor-page.js' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const outputs = Array.isArray(built) ? built : [built];
  const chunk = outputs.flatMap((o) => o.output).find((o): o is Rollup.OutputChunk => o.type === 'chunk');
  if (!chunk) throw new Error('the page bundle produced no chunk');
  pageBundle = chunk.code;
  return pageBundle;
}

async function open(page: Page) {
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: await bundle() });
}

/** The file page's editor on `content`, with the caret at `at` and `typed` typed there. */
async function editFile(page: Page, filePath: string, content: string, at: 'Home' | 'End', typed: string) {
  await open(page);
  await page.evaluate((opts) => window.mountFileEditor(opts), { content, filePath });
  const box = page.getByRole('textbox');
  // The intermediary itself: what the browser hands back for this file.
  expect(await box.inputValue()).toBe(content.replace(/\r\n/g, '\n'));
  await box.click();
  await page.keyboard.press(`Control+${at}`);
  await page.keyboard.type(typed);
}

const written = (page: Page) => page.evaluate(() => window.written);

// Bundling the editors with vite takes most of this, more under a parallel run.
test.setTimeout(90_000);

test('a CRLF page edited at its end and saved with Ctrl+S keeps every untouched CRLF', async ({ page }) => {
  await editFile(page, 'knowledge-base/QA-Edit/crlf.md', '# CRLF\r\n\r\nalpha\r\nbeta\r\n', 'End', 'gamma');
  await page.keyboard.press('Control+s');
  await expect.poll(() => written(page)).toEqual(['# CRLF\r\n\r\nalpha\r\nbeta\r\ngamma']);
});

test('a CRLF page edited on its first line and saved on Done keeps the other lines CRLF', async ({ page }) => {
  await editFile(page, 'knowledge-base/QA-Edit/crlf2.md', 'one\r\ntwo\r\nthree\r\n', 'Home', 'zero ');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => written(page)).toEqual(['zero one\r\ntwo\r\nthree\r\n']);
});

test('a new line typed into a CRLF plain-text file ends with CRLF', async ({ page }) => {
  await editFile(page, 'knowledge-base/notes.txt', 'a\r\nb\r\n', 'End', 'c\nd');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => written(page)).toEqual(['a\r\nb\r\nc\r\nd']);
});

test('an LF page stays LF', async ({ page }) => {
  await editFile(page, 'knowledge-base/notes.md', 'one\ntwo\n', 'End', 'three');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => written(page)).toEqual(['one\ntwo\nthree']);
});

/**
 * The skill page's editor, on mixed-ending files. It used to write every line
 * CRLF when the file had a CRLF anywhere; now the lines an edit does not reach
 * keep their own ending, and the lines it adds take the one most lines have.
 */
for (const { file, typed, saved } of [
  // Mostly LF, one CRLF: the CRLF line stays, the new lines are LF (was: all CRLF).
  { file: 'one\ntwo\r\nthree\n', typed: 'four\nfive', saved: 'one\ntwo\r\nthree\nfour\nfive' },
  // Mostly CRLF, one LF: the LF line stays, the new lines are CRLF (was: all CRLF, the LF line too).
  { file: 'one\r\ntwo\nthree\r\n', typed: 'four\nfive', saved: 'one\r\ntwo\nthree\r\nfour\r\nfive' },
]) {
  test(`the skill page's editor saves ${JSON.stringify(file)} + an edit as ${JSON.stringify(saved)}`, async ({ page }) => {
    await open(page);
    await page.evaluate((content) => window.mountSkillEditor({ content }), file);
    const box = page.getByRole('textbox', { name: 'Edit SKILL.md' });
    expect(await box.inputValue()).toBe(file.replace(/\r\n/g, '\n'));
    await box.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(typed);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => written(page)).toEqual([saved]);
  });
}
