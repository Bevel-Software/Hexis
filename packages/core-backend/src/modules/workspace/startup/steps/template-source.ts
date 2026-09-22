import path from 'node:path';
import { agentsFileOf, currentKbLayout, gitignoreLiteral, renderKbLayoutPlaceholders } from '@bevel-software/platform-shared';
import { IGNORE_FILENAME, isAbsence, type EntryStat, type IFsProbe } from '../../../../shared/fs.contract.js';
import { PREAMBLE_FILE } from '../../../agent-instructions/compose.js';
import { defaultKbTemplateDir } from '../../../../assets.js';
import { logger } from '../../../../shared/logging.js';

const log = logger('kb-startup');

/**
 * Required files added AFTER a distribution may have forked the template. A
 * custom `KB_TEMPLATE_DIR` that predates one of these would otherwise stop
 * the boot with ENOENT on the first start after an upgrade, on every
 * protected branch, over a file whose shipped content is one comment. For
 * these the packaged template's copy stands in, with one line in the log;
 * every other required file keeps the strict contract (a custom template
 * missing `access.md` is a real mistake and should fail loudly).
 */
export const PACKAGED_FALLBACK_FILES: ReadonlySet<string> = new Set([PREAMBLE_FILE]);

/**
 * Destination name → the packable spelling the template may carry instead.
 * npm strips every file named `.gitignore` from a published tarball, so the
 * packaged template cannot ship one under its real name (see
 * {@link TemplateSource.pathOf}).
 *
 * A `Map`, not an object literal, because the KEY IS A FILENAME and a
 * template is free to carry a file called `constructor` or `toString`: an
 * object lookup would answer those from `Object.prototype` and hand a
 * FUNCTION to `path.join`, failing the seed of a whole knowledge base with a
 * type error naming nothing. A Map has no prototype chain to fall through,
 * so the question "does the template spell this differently?" can only ever
 * be answered by an entry someone actually wrote here.
 */
export const TEMPLATE_SOURCE_FALLBACKS: ReadonlyMap<string, string> = new Map([
  ['.gitignore', 'gitignore.template'],
]);

/**
 * ONE template directory, read through ONE disk port — what both readers of
 * the KB template share.
 *
 * The top-up step (template-files.step.ts) and the empty-remote seeder
 * (seed-tree.ts) each used to resolve, read and compare template files
 * through free functions taking `(disk, templateDir, …)`, which meant the
 * port and the directory travelled as arguments through every call and the
 * packable-name fallback had to be re-applied by hand at each site. Bound
 * once here instead: the directory is the object, the port is its
 * collaborator, and every caller asks by repo-relative path alone.
 *
 * Constructed per run rather than injected: `templateDir` is runtime data
 * (the step reads it off the start context, the seeder off config) while the
 * PORT is the injected dependency. The port is what crosses the module
 * boundary, as an interface — this class only ever sees {@link IFsProbe}.
 */
export class TemplateSource {
  constructor(
    private readonly disk: IFsProbe,
    private readonly templateDir: string,
  ) {}

  /**
   * Where `relPath`'s template content actually lives. npm refuses to pack
   * files named `.gitignore` — every such file is silently stripped from the
   * published tarball — so the packaged template ships the KB's gitignore
   * under a packable name and the seeder writes it to its real one. A
   * template carrying the literal file (a distribution's own
   * KB_TEMPLATE_DIR, or this repo's tree in a Docker build) wins outright:
   * the mapping is a fallback, never a rename.
   */
  async pathOf(relPath: string): Promise<string> {
    const direct = path.join(this.templateDir, relPath);
    if (await this.there(direct)) return direct;
    const packable = TEMPLATE_SOURCE_FALLBACKS.get(relPath);
    if (packable !== undefined) {
      const fallback = path.join(this.templateDir, packable);
      if (await this.there(fallback)) return fallback;
    }
    return direct; // let the ENOENT surface under the name the caller asked for
  }

  /** The directory itself — for the seeder, which WALKS the template. */
  get root(): string {
    return this.templateDir;
  }

  /** Stat the template directory itself — `null` when it is not there at all. */
  async rootStat(): Promise<EntryStat | null> {
    return this.disk.statOrNull(this.templateDir);
  }

  /**
   * Stat a template-relative path, links followed — `null` when nothing is
   * there. The seeder asks this about the entries its walk turned up, so it
   * never has to join the template directory onto a path itself.
   */
  async statOf(relPath: string): Promise<EntryStat | null> {
    return this.disk.statOrNull(path.join(this.templateDir, relPath));
  }

  /** Whether the template carries `relPath` under its own literal name. */
  async carries(relPath: string): Promise<boolean> {
    return this.there(path.join(this.templateDir, relPath));
  }

  /**
   * The template's content for `relPath`, RENDERED: the managed files name
   * the three root folders, and a deployment may have renamed those, so the
   * placeholders the template carries (`{{pluginsDir}}` …) are filled with
   * the names in effect. Every required file is text; a template without
   * placeholders passes through unchanged.
   */
  async read(relPath: string): Promise<string> {
    let raw: string;
    try {
      raw = await this.disk.readTextFile(await this.pathOf(relPath));
    } catch (err) {
      const packaged = defaultKbTemplateDir();
      if (!isAbsence(err) || !PACKAGED_FALLBACK_FILES.has(relPath) || this.templateDir === packaged) {
        throw err;
      }
      log.warn(
        `template-files: the configured KB template has no "${relPath}"; ` +
          'using the packaged copy. Add the file to the template to silence this.',
      );
      // The packaged copy, read the same way — it renders its own
      // placeholders and cannot fall back again (its guard is this one).
      return new TemplateSource(this.disk, packaged).read(relPath);
    }
    // In the ignore file the guide's name is a PATTERN, and a name gitignore
    // reads as syntax (`#Guide.md`, `!Guide.md`, brackets) would hide nothing
    // written bare. Escaped there, and only there: everywhere else the
    // placeholder is prose. ONE render, with the escaped name as the layout's
    // — a second pass over the rendered text would read a name that happens
    // to contain a placeholder as one.
    if (relPath === IGNORE_FILENAME) {
      const layout = currentKbLayout();
      return renderKbLayoutPlaceholders(raw, { ...layout, agentsFile: gitignoreLiteral(agentsFileOf(layout)) });
    }
    return renderKbLayoutPlaceholders(raw);
  }

  /**
   * Whether the repo's copy of `relPath` differs from the RENDERED
   * template's, modulo line endings — a CRLF checkout of identical content
   * must read as "same", or the managed-file refresh would commit churn on
   * every boot forever. Rendered, so a renamed root is compared against the
   * guide that names it, not against the placeholders.
   *
   * `templateRel` is the template's own name for the file, when the two differ.
   * They do for exactly one file: the agent guide ships as `AGENTS.md` and is
   * written under whatever this deployment calls it, so the comparison has to
   * name both ends.
   */
  async differsFrom(repoDir: string, relPath: string, templateRel: string = relPath): Promise<boolean> {
    const norm = (text: string) => text.replace(/\r\n?/g, '\n');
    const [current, template] = await Promise.all([
      this.disk.readTextFile(path.join(repoDir, relPath)),
      this.read(templateRel),
    ]);
    return norm(current) !== norm(template);
  }

  /** Links followed: a template file reached through a link is there. */
  private async there(p: string): Promise<boolean> {
    return (await this.disk.statOrNull(p)) !== null;
  }
}
