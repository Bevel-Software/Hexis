import type { UIMessage } from 'ai';
import type { AuthUser } from '../auth/types.js';

/**
 * Domain-owned alias for the AI SDK v5 UIMessage shape.
 *
 * Backend and frontend both import `ChatUIMessage` rather than `UIMessage`
 * directly so the seam is renameable if the SDK type shifts.
 */
export type ChatUIMessage = UIMessage;

export interface ChatThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

// Calibrated for gpt-5.1 (~400k context) with current agent.instructions.ts size
// + typical KB file tree. Lower than the raw window because the system prompt
// and workspace state occupy ~40-80k before the user types. Re-tune if the
// model changes or the system prompt grows materially.
//
// Both thresholds drive the agent's input processors in BaseAgentFactory:
//   - softLimit  → SummaryCompactor recaps the middle of the transcript
//   - hardLimit  → TokenLimiterProcessor backstops with truncation
// The composer's context-usage gauge also reads these via the UsagePartData
// emitted at end-of-turn.
export const COMPACTION_SOFT_LIMIT_TOKENS = 200_000;
export const COMPACTION_HARD_LIMIT_TOKENS = 350_000;

/** Per-turn token usage attached to the assistant message via a `data-usage` part. */
export interface UsagePartData {
  used: number;
  softLimit: number;
  hardLimit: number;
}

export interface IChatService {
  streamResponse(params: {
    message: string;
    resourceId: string;
    threadId: string;
    workspaceId: string;
    /**
     * Required — the agent authors every git commit as the user, and the
     * author marker it pastes into PR bodies is derived from the user's email.
     * Backend reads `user.name` and `user.email` unconditionally.
     */
    user: AuthUser;
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<unknown>>;
}
