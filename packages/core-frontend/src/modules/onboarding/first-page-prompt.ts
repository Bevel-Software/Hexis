/**
 * The one-click first prompt behind "Write your first page": a request a
 * connected agent can act on straight away, and the links that open it in a
 * new chat already typed.
 *
 * Short on purpose. It travels in a URL, and a page about the company is the
 * one every knowledge base needs and every new person can answer for — the
 * agent asks for what it cannot find rather than inventing it.
 */
export const FIRST_PAGE_PROMPT =
  "Using our Hexis knowledge base, write a page in Knowledge about our company: what we do, who we work with, and our main products. Ask me for anything you don't know, then save it.";

/** A new Claude chat with `prompt` typed into it (claude.ai's `q` parameter prefills; the person still sends). */
export function claudePromptUrl(prompt: string): string {
  return `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;
}

/** The same for ChatGPT, whose `q` parameter prefills a new chat. */
export function chatGptPromptUrl(prompt: string): string {
  return `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`;
}
