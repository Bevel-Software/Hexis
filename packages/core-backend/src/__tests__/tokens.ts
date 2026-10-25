import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import { GUIDE_TOKEN_ENCODING } from '../modules/agent-guide/guide-budget.js';

/**
 * Token counts for the tests that hold agent-facing text to a budget
 * (`modules/agent-guide/guide-budget.ts`): a real BPE tokenizer, offline and
 * deterministic, so a count in CI is the count on a laptop. Built once: the
 * rank table is large and the counts never change between calls.
 */
const encoder = new Tiktoken(o200kBase);

if (GUIDE_TOKEN_ENCODING !== 'o200k_base') {
  throw new Error(`The budgets name ${GUIDE_TOKEN_ENCODING}, but the counter is built on o200k_base.`);
}

export function countTokens(text: string): number {
  return encoder.encode(text).length;
}
