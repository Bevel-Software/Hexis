import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `text-*` is ambiguous: it is BOTH the font-size namespace and the
 * text-colour namespace. tailwind-merge resolves that with a built-in list of
 * Tailwind's own scale names — which does not include ours.
 *
 * Untaught, it classifies a custom size like `text-ui` as a COLOUR, decides it
 * conflicts with `text-ink-muted`, and silently drops the colour:
 *
 *   cn('text-ink-muted', 'text-ui')  ->  'text-ui'      // colour lost
 *
 * That is a silent, app-wide text-colour bug the moment a primitive composes a
 * size and a colour, which every one of them does. Declaring the design
 * system's scales here is what makes `cn()` safe to build primitives on.
 *
 * Keep these in sync with `src/shared/theme/tokens.css`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      // font sizes — see `--text-*` in tokens.css
      text: [
        'micro',
        'label',
        'meta',
        'detail',
        'ui',
        'body',
        'strong',
        'lede',
        'title',
        'head',
        'display-sm',
        'display',
      ],
      // semantic colours — see `--color-*` in tokens.css
      color: [
        'canvas',
        'sidebar',
        'surface',
        'surface-hover',
        'sunken',
        'ink',
        'ink-muted',
        'ink-faint',
        'line',
        'line-strong',
        'hover',
        'accent',
        'accent-hover',
        'ok',
        'ok-soft',
        'wait',
        'wait-soft',
        'wait-dot',
        'danger',
        'danger-soft',
        'mark-del',
        'mark-ins',
        'scrim',
        // brand purple — outside the design system, fate pending (T21)
        'bevel',
        'bevel-deep',
        'bevel-soft',
      ],
      shadow: ['overlay', 'card'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Hide the extension in display labels. Dot-prefixed names (.env, .gitignore)
// keep their full name. Compound suffixes (foo.test.ts) only lose the final part.
export function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return filename;
  return filename.slice(0, lastDot);
}

export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return '';
  return filename.slice(lastDot + 1).toLowerCase();
}

const ICON_BY_FILENAME: Record<string, string> = {
  'package.json': 'nodejs',
  'package-lock.json': 'nodejs',
  'pnpm-lock.yaml': 'pnpm',
  'pnpm-workspace.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'tsconfig.json': 'tsconfig',
  'tsconfig.base.json': 'tsconfig',
  'vite.config.ts': 'vite',
  'vite.config.js': 'vite',
  'vitest.config.ts': 'vitest',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.prettierrc': 'prettier',
  '.prettierrc.json': 'prettier',
  '.prettierignore': 'prettier',
  '.eslintrc': 'eslint',
  '.eslintrc.json': 'eslint',
  '.eslintrc.js': 'eslint',
  'eslint.config.js': 'eslint',
  'eslint.config.ts': 'eslint',
  dockerfile: 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  makefile: 'makefile',
  'readme.md': 'readme',
  readme: 'readme',
  license: 'license',
  'license.md': 'license',
  '.env': 'tune',
  '.env.local': 'tune',
  '.env.production': 'tune',
  '.env.development': 'tune',
  'components.json': 'json',
};

const ICON_BY_EXT: Record<string, string> = {
  md: 'markdown',
  mdx: 'markdown',
  txt: 'document',
  rtf: 'document',
  pdf: 'pdf',
  ts: 'typescript',
  tsx: 'react-ts',
  js: 'javascript',
  jsx: 'react',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  sh: 'console',
  bash: 'console',
  zsh: 'console',
  fish: 'console',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  json: 'json',
  jsonc: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  csv: 'table',
  tsv: 'table',
  xls: 'table',
  xlsx: 'table',
  ods: 'table',
  sql: 'database',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  svg: 'svg',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  ogg: 'audio',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  avi: 'video',
  zip: 'zip',
  tar: 'zip',
  gz: 'zip',
  '7z': 'zip',
  rar: 'zip',
  ttf: 'font',
  otf: 'font',
  woff: 'font',
  woff2: 'font',
};

const DEFAULT_ICON = 'document';

export function getFileIcon(filename: string): string {
  const lower = filename.toLowerCase();
  const override = ICON_BY_FILENAME[lower];
  if (override) return override;
  return ICON_BY_EXT[getFileExtension(filename)] ?? DEFAULT_ICON;
}
