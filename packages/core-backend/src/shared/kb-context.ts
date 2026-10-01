import {
  UNCONFIGURED_BRANCH_MODEL,
  isBranchModelConfigured,
  isProtectedBranch,
  resolveBranchModel,
  resolveKbLayout,
  validateBranchModel,
  type BranchModel,
  type BranchModelValue,
  type KbLayout,
} from '@bevel-software/platform-shared';
import { workspaceIdForBranch } from './workspace-id.js';

/**
 * What ONE knowledge base is called, on disk and in git: the checkout folder
 * inside each workspace, the branch model (default + protected branches) and
 * the layout (the three renameable roots and the guide's file name).
 *
 * Every service that needs one of these is handed the knowledge base's
 * context at construction and reads it there — never a process-wide value.
 * The shared package's live bindings (`DEFAULT_BRANCH`, `PLUGINS_DIR`, …) are
 * the BROWSER'S copy of the same facts and are forbidden in this package by
 * an ESLint rule: a server hosting several knowledge bases in one process has
 * no single value to put there, and a service that read one would be reading
 * whichever knowledge base configured it last.
 *
 * LIVE, PER INSTANCE. The values are read through getters, not captured, for
 * the same reason the live bindings were: a fresh deployment has no branch
 * model until its setup screen is answered, and the save that completes setup
 * applies one to the running graph — through {@link applyBranchModel} and
 * {@link applyLayout} — so the knowledge-base startup phase that runs in that
 * same request already sees it. Read `defaultBranch` inside a method body;
 * a value copied into a field at construction would be the empty string on
 * exactly those deployments.
 */
export class KbContext {
  private model: BranchModelValue;
  private layoutValue: Required<KbLayout>;
  private readonly layoutListeners = new Set<() => void>();
  private readonly branchModelListeners = new Set<() => void>();

  constructor(
    /** The checkout folder inside each workspace directory (`knowledge-base` by default). */
    readonly kbDirName: string,
    branchModel: BranchModelValue,
    layout: KbLayout,
  ) {
    this.model = branchModel;
    this.layoutValue = resolveKbLayout(layout);
  }

  /**
   * The model as a deployment's settings describe it, or the unconfigured one
   * when they describe none yet. UNCONFIGURED IS ALLOWED, and that is the
   * point: a fresh deployment has no branch model, and refusing to build
   * services would take away the setup screen where one gets entered. What
   * reads the model before then is the setup path itself, which does not need
   * it; the setup gate keeps the rest of the app shut until it is set.
   */
  static branchModelOrUnconfigured(model: BranchModel): BranchModelValue {
    return validateBranchModel(model) ? UNCONFIGURED_BRANCH_MODEL : resolveBranchModel(model);
  }

  get branchModel(): BranchModelValue {
    return this.model;
  }

  /** The branch users land on and the default propose target; `''` until configured. */
  get defaultBranch(): string {
    return this.model.defaultBranch;
  }

  get protectedBranches(): ReadonlySet<string> {
    return this.model.protectedBranches;
  }

  isProtectedBranch(name: string | null | undefined): boolean {
    return isProtectedBranch(this.model, name);
  }

  isBranchModelConfigured(): boolean {
    return isBranchModelConfigured(this.model);
  }

  /** The workspace id of the default branch's clone — the released catalog's home. */
  defaultWorkspaceId(): string {
    return workspaceIdForBranch(this.model.defaultBranch);
  }

  /** The layout in effect: the three roots and the guide's file name, every name trimmed. */
  get layout(): Required<KbLayout> {
    return this.layoutValue;
  }

  /**
   * Apply a branch model to the running graph — the setup-completing save.
   * Validated like every model, so a bad pair is refused rather than applied
   * half-way. Listeners run after the value is in place.
   */
  applyBranchModel(model: BranchModel): void {
    this.model = resolveBranchModel(model);
    for (const listener of this.branchModelListeners) listener();
  }

  /**
   * Apply a layout to the running graph — the setup-completing save, so the
   * knowledge-base phase that runs in the same request scaffolds the names the
   * admin just chose. Throws on an invalid one. Listeners run after the value
   * is in place, and only when the layout was accepted.
   */
  applyLayout(layout: KbLayout): void {
    this.layoutValue = resolveKbLayout(layout);
    for (const listener of this.layoutListeners) listener();
  }

  /**
   * Be told when {@link applyLayout} runs — for the few things that cannot
   * read the layout at the moment they are used: a value BUILT ONCE and handed
   * to something that keeps it, such as the tool catalog's descriptions, which
   * are validated into frozen defs at registration and then served from a map.
   */
  onLayoutApplied(listener: () => void): void {
    this.layoutListeners.add(listener);
  }

  /** Be told when {@link applyBranchModel} runs. */
  onBranchModelApplied(listener: () => void): void {
    this.branchModelListeners.add(listener);
  }
}
