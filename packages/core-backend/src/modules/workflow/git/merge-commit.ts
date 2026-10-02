/**
 * The subject line a change request's merge commit carries, written in one place
 * and READ BACK in another.
 *
 * `mergePr` has always built this subject; what is new is that something now
 * depends on reading it. An applied change request is read back from the merge
 * commit its row records (`merged_sha`), and that row cannot be trusted to point
 * at a commit this request created: when the target already contains the source,
 * `mergeChangeRequest` makes no commit at all and reports the TARGET TIP as the
 * merged state. In a deployment that lands everything through change requests
 * that tip is usually ANOTHER request's merge commit — so reading "the recorded
 * commit's own change" would answer with somebody else's files, under this
 * request's number (cubic P1 on PR #347).
 *
 * The write side is fixed too — a merge that creates no commit now records no
 * sha — but rows written before that fix exist, so the read verifies rather than
 * assumes. The number in the subject is the cheapest honest proof available: it
 * is in the commit, it is immutable, and no other request's merge commit carries
 * it.
 *
 * Both functions live here, next to each other, so the format cannot drift on
 * one side only. `git.service.appliedChangeShas` is tested against a commit
 * written with {@link mergeCommitSubject}, so changing the format without
 * changing the predicate fails the suite rather than quietly making every
 * applied request author-only.
 */

/**
 * The merge commit's subject for request `number` titled `title`.
 *
 * The title is flattened to ONE line, because the number only proves anything
 * where git reports it. `%s` is the first PARAGRAPH of the message joined with
 * spaces, so a single newline in the title is harmless — but a BLANK line (two
 * newlines, or a whitespace-only line) ends that paragraph, and nothing rejects
 * one: a title is stored `.trim()`-ed and the tool schema bounds only its
 * length. The subject would then end before `(#N)`,
 * {@link mergeCommitSubjectNames} would refuse the request's OWN merge commit,
 * and every applied request with such a title would read as author-only with no
 * files (cubic P2 on PR #347).
 *
 * Flattened here rather than rejected at the write side so the titles already
 * stored are covered too — and because a merge is the wrong moment to discover
 * that a title typed days ago is unacceptable.
 */
export function mergeCommitSubject(title: string, number: number): string {
  return `${title.replace(/\s+/g, ' ').trim()} (#${number})`;
}

/**
 * Whether `subject` is the subject of request `number`'s own merge commit.
 *
 * Matched at the END, because that is where {@link mergeCommitSubject} puts the
 * number and a title may contain anything — including another request's number,
 * which a looser match would accept.
 */
export function mergeCommitSubjectNames(subject: string, number: number): boolean {
  return subject.trimEnd().endsWith(`(#${number})`);
}
