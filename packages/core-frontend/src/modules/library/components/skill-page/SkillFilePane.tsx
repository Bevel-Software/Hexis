import type { ReactNode } from 'react';
import '../../../change-requests/change-requests.css';
import { FilePaneCard } from '../../../workspace/components/FilePaneCard';
import { KbMarkdownView } from '../../../workspace/components/renderers/KbMarkdownView';
import type { KbImageResolver } from '../../../workspace/components/renderers/kbMarkdownPipeline';
import { HtmlRenderer } from '../../../workspace/components/renderers/HtmlRenderer';
import { OpenPageInPlatformContext, PageToolsContext } from '../../../workspace';
import type { DiffLine } from '../../../change-requests/utils/diff';

/** The pane never writes — editing goes through the page's Edit / Propose. */
const NOOP_SAVE = async () => {};

interface SkillFilePaneProps {
  /** Repo-relative-to-the-skill file name, e.g. `SKILL.md`. */
  file: string;
  /** Raw file content, or null while it loads. */
  raw: string | null;
  /**
   * The caller's own pending suggestion rendered against `raw`, or null when
   * there is none. Present ⇒ the pane shows the diff INSTEAD of the file: you
   * are looking at what you proposed, not at what is there today.
   */
  suggestion: DiffLine[] | null;
  /** Right-hand side of the file bar — Edit, Propose changes, whatever the page owns. */
  actions?: ReactNode;
  /** Sits between the bar and the body: the "your suggestions are inline" strip. */
  notice?: ReactNode;
  /** Follow a relative link out of rendered markdown. */
  onOpenLink?(href: string): void;
  /** Resolve a bare `[text](node-id)` link — same contract as `KbMarkdownView`. */
  onOpenNodeId?(id: string): void;
  /** Heading deep-link builder; present ⇒ headings get the copy-anchor button. */
  headingLink?(slug: string): string;
  /** Image source resolver, same contract as `KbMarkdownView`; absent ⇒ plain `<img>` tags. */
  resolveImage?: KbImageResolver;
  /**
   * The file's knowledge-base path (`Skills/review/view.html`) — the path the
   * file page gives the page-tool bridge for the same file. Present, an HTML
   * page here gets the viewer's tools, recorded under this path; absent (the
   * skill's path has not resolved yet), it gets none.
   */
  pagePath?: string;
  /**
   * Open this file on the app's file page — what an HTML page's "Open in the
   * platform" does here, since `file` is relative to the skill, not a
   * workspace path. The renderer offers it only to a page without tools,
   * i.e. while `pagePath` is absent.
   */
  onOpenInPlatform?(): void;
}

/**
 * One file, in a box — the prototype's `.filepane` (line 253): a bar naming the
 * file with its actions, and the file itself below.
 *
 * The box is the point. A skill is a FOLDER of files, and the tabs above only
 * make sense if the thing they switch has an edge you can see; without it the
 * body reads as page content that happens to change when you click a tab.
 *
 * The box itself is `FilePaneCard` — the same frame the Knowledge viewer
 * mounts around its documents, so the two surfaces cannot drift apart.
 */
export function SkillFilePane({
  file,
  raw,
  suggestion,
  actions,
  notice,
  onOpenLink,
  onOpenNodeId,
  headingLink,
  resolveImage,
  pagePath,
  onOpenInPlatform,
}: SkillFilePaneProps) {
  return (
    <FilePaneCard file={file} actions={actions} notice={notice} className="mt-4">
      {raw === null ? (
        <p className="py-4 text-center text-detail text-ink-faint">Loading…</p>
      ) : suggestion ? (
        <SuggestionDiff lines={suggestion} />
      ) : file.endsWith('.md') ? (
        // The SAME renderer, in the same configuration, as the Knowledge
        // view of this file: raw source (so the frontmatter panel shows),
        // id-link resolution, heading copy-anchors. `scroll={false}`
        // because the library page is the scroller — a nested scrollbox
        // here would trap the wheel inside the pane.
        <KbMarkdownView
          source={raw}
          onOpenFile={(href) => onOpenLink?.(href)}
          onOpenNodeId={onOpenNodeId}
          headingLink={headingLink}
          resolveImage={resolveImage}
          scroll={false}
        />
      ) : /\.html?$/i.test(file) ? (
        // The same sandboxed preview the Knowledge viewer gives `.html` — a
        // skill's bundled template (a deck, a report shell) is meant to be
        // SEEN; the renderer's own Code tab keeps the source one click away.
        // Sized wrapper because the renderer fills its parent, and this card
        // has no height of its own. The skill page is the platform: the
        // page's `window.bevel.tools` is answered here as on its file page.
        <div className="h-[70vh]">
          <PageToolsContext.Provider value={pagePath ? { pagePath } : null}>
            <OpenPageInPlatformContext.Provider value={onOpenInPlatform ?? null}>
              <HtmlRenderer content={raw} filePath={file} readOnly onSave={NOOP_SAVE} />
            </OpenPageInPlatformContext.Provider>
          </PageToolsContext.Provider>
        </div>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-detail leading-relaxed text-ink-muted">
          {raw}
        </pre>
      )}
    </FilePaneCard>
  );
}

/**
 * Removed and added lines as `<del>` / `<ins>`, not coloured `<div>`s: what is
 * on screen is a claim about what changed, and the elements that MEAN that are
 * the ones a screen reader announces as such. The colours come from `.lib-sug`
 * in `library.css` — the same rule the compare view's marks use, so an inline
 * suggestion and a reviewed one never drift apart visually.
 */
function SuggestionDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="lib-sug whitespace-pre-wrap break-words font-mono text-detail leading-relaxed text-ink-muted">
      {lines.map((l, i) =>
        l.kind === 'same' ? (
          <div key={i}>{l.text || ' '}</div>
        ) : l.kind === 'removed' ? (
          <del key={i} className="block">
            {l.text || ' '}
          </del>
        ) : (
          <ins key={i} className="block">
            {l.text || ' '}
          </ins>
        ),
      )}
    </pre>
  );
}
