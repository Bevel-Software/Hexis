/**
 * Metering view over connection-key LLM usage, consumed by the connection-key
 * management routes (mcp) to show each key's spend against the daily budget.
 * The enterprise LLM proxy's `LlmUsageService` satisfies this structurally; a
 * core-only deployment (no LLM proxy, nothing to meter) passes
 * {@link unmeteredLlmUsage}.
 */
export interface ILlmUsageMeter {
  /** Daily per-key token cap shown in the UI, or null when unmetered. */
  readonly dailyCap: number | null;
  /** Today's usage per key id, as `{ [tokenId]: tokens }` — missing keys mean 0. */
  usageForTokens(tokenIds: string[]): Promise<Record<string, number>>;
}

/** Core default: no proxy, no metering — every key reads as unused/uncapped. */
export const unmeteredLlmUsage: ILlmUsageMeter = {
  dailyCap: null,
  usageForTokens: async () => ({}),
};
