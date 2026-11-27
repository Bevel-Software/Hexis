import { VersionControlDomainError } from '../../shared/domain-errors.js';

/**
 * A merge was asked to land one commit of its source branch and the published
 * branch is at another: someone pushed to it after the caller read its head.
 * Nothing was merged. A 409 whose payload is `{ kind: 'source-head-moved' }`;
 * a caller that answers in its own words tells it apart by its type.
 *
 * Raised by `GitService.mergeChangeRequest` and answered by the review
 * service's `mergePr`, both in this module, so it lives here and not among
 * the errors every module shares.
 */
export class SourceHeadMovedError extends VersionControlDomainError {
  readonly kind = 'source-head-moved' as const;
  constructor(readonly sourceBranch: string) {
    super(
      `"${sourceBranch}" changed after it was last read, so it was not merged. Read it again and merge once more.`,
      409,
      { kind: 'source-head-moved' },
    );
    this.name = 'SourceHeadMovedError';
  }
}
