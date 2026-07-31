import type { PostPrCommentInput, PrReviewComment } from '@bevel-software/shared';
import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';

export async function listPrComments(prNumber: number): Promise<PrReviewComment[]> {
  return handleApiResponse(await authFetch(`/api/workflow/change-requests/${prNumber}/comments`));
}

export async function postPrComment(
  prNumber: number,
  input: PostPrCommentInput,
): Promise<PrReviewComment> {
  return handleApiResponse(
    await authFetch(`/api/workflow/change-requests/${prNumber}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function editPrComment(
  prNumber: number,
  commentId: string,
  body: string,
): Promise<PrReviewComment> {
  return handleApiResponse(
    await authFetch(`/api/workflow/change-requests/${prNumber}/comments/${commentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }),
  );
}

export async function deletePrComment(
  prNumber: number,
  commentId: string,
): Promise<void> {
  await handleApiResponse(
    await authFetch(`/api/workflow/change-requests/${prNumber}/comments/${commentId}`, {
      method: 'DELETE',
    }),
  );
}
