import { cn } from '../../../lib/utils';

/**
 * A tool's mark — the prototype's `.logo` + `MARKS` (lines 168-175, 1112).
 *
 * Two tiers, and the second is what makes the first safe to have:
 *
 *  1. A handful of services get their REAL logo, because a person scanning a
 *     grid recognises Slack's four-colour hash faster than they read the word
 *     "slack". These are the marks the prototype ships, unchanged.
 *  2. Everything else gets a monogram — first letter, on a colour derived from
 *     the slug. Not a placeholder to be replaced later: the KB accepts any
 *     `.tool` anybody writes, so the general case is a tool nobody has drawn a
 *     logo for, and it has to look deliberate rather than missing.
 *
 * The monogram's colour is a pure function of the slug, so a tool keeps the
 * same one forever and two tools are unlikely to collide on screen. Never
 * random, never index-based: an index would reshuffle every mark whenever the
 * catalog gained an entry.
 */

export interface ToolLogoProps {
  /** The tool's slug — picks the mark and seeds the monogram's colour. */
  slug: string;
  /** Falls back to the slug for the monogram letter. */
  name?: string;
  size?: 'sm' | 'lg';
  className?: string;
}

/**
 * Slugs → marks. Keyed on OUR slugs (`google_gmail`, not `gmail`), because
 * that is what the `.tool` files declare and what every caller already holds.
 */
const MARK_FOR: Record<string, keyof typeof MARKS> = {
  slack: 'slack',
  github: 'github',
  notion: 'notion',
  google_gmail: 'gmail',
  google_calendar: 'gcal',
  gmail: 'gmail',
  gcal: 'gcal',
};

/**
 * Marks that are drawn in ONE colour and should take the surrounding ink
 * rather than a brand colour — GitHub's and Notion's logos are black by
 * design, so on a dark surface a hard-coded `#000` would vanish.
 */
const INK_MARKS = new Set<keyof typeof MARKS>(['github', 'notion']);

/** Monogram backgrounds. Muted enough to sit in a grid without shouting. */
const MONO_TONES = [
  { bg: '#eaf1ea', fg: '#4f7a52' },
  { bg: '#e9eefb', fg: '#4560a8' },
  { bg: '#fbeeea', fg: '#a85a41' },
  { bg: '#f2eafa', fg: '#6f4a9b' },
  { bg: '#e7f2f4', fg: '#3d7783' },
  { bg: '#faf0e2', fg: '#8a6a2f' },
];

/** Stable, order-independent bucket for a slug. */
function toneFor(slug: string) {
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  return MONO_TONES[hash % MONO_TONES.length]!;
}

export function ToolLogo({ slug, name, size = 'sm', className }: ToolLogoProps) {
  const mark = MARK_FOR[slug];
  const box = cn(
    'flex shrink-0 items-center justify-center overflow-hidden border border-line bg-sunken',
    size === 'lg' ? 'size-10 rounded-lg' : 'size-6.5 rounded-md',
    className,
  );

  if (mark) {
    return (
      <span aria-hidden="true" className={cn(box, INK_MARKS.has(mark) && 'text-ink')}>
        <svg
          viewBox={MARKS[mark].viewBox}
          className={size === 'lg' ? 'size-5.5' : 'size-3.5'}
          focusable="false"
        >
          {MARKS[mark].paths}
        </svg>
      </span>
    );
  }

  const tone = toneFor(slug);
  const letter = (name || slug).trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      aria-hidden="true"
      className={cn(box, 'font-bold', size === 'lg' ? 'text-lede' : 'text-meta')}
      style={{ backgroundColor: tone.bg, color: tone.fg }}
    >
      {letter}
    </span>
  );
}

/**
 * The brand marks, lifted from the prototype verbatim.
 *
 * Inline rather than an icon package: `simple-icons` and friends ship
 * thousands of paths to deliver five, and these are the only five the product
 * has any claim to draw.
 */
const MARKS = {
  slack: {
    viewBox: '0 0 122.8 122.8',
    paths: (
      <>
        <path
          fill="#E01E5A"
          d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zM32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
        />
        <path
          fill="#36C5F0"
          d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zM45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
        />
        <path
          fill="#2EB67D"
          d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zM90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"
        />
        <path
          fill="#ECB22E"
          d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zM77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"
        />
      </>
    ),
  },
  github: {
    viewBox: '0 0 24 24',
    paths: (
      <path
        fill="currentColor"
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
      />
    ),
  },
  notion: {
    viewBox: '0 0 24 24',
    paths: (
      <path
        fill="currentColor"
        d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"
      />
    ),
  },
  gmail: {
    viewBox: '0 0 24 24',
    paths: (
      <path
        fill="#EA4335"
        d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"
      />
    ),
  },
  gcal: {
    viewBox: '0 0 24 24',
    paths: (
      <path
        fill="#4285F4"
        d="M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z"
      />
    ),
  },
} as const;
