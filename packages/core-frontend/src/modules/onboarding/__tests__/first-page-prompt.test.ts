import { describe, expect, it } from 'vitest';
import { FIRST_PAGE_PROMPT, chatGptPromptUrl, claudePromptUrl, firstPagePromptFor, firstPageRoute } from '../first-page-prompt';

/**
 * The first-page prompt links: the prompt must arrive in the chat exactly as
 * written — every space, colon, comma and apostrophe — and stay short enough
 * to travel in a URL.
 */

describe('first-page prompt links', () => {
  it('opens a new Claude chat with the prompt as its q parameter, round-tripping exactly', () => {
    const url = new URL(claudePromptUrl(FIRST_PAGE_PROMPT));
    expect(url.origin).toBe('https://claude.ai');
    expect(url.pathname).toBe('/new');
    expect(url.searchParams.get('q')).toBe(FIRST_PAGE_PROMPT);
  });

  it('opens a new ChatGPT chat the same way', () => {
    const url = new URL(chatGptPromptUrl(FIRST_PAGE_PROMPT));
    expect(url.origin).toBe('https://chatgpt.com');
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('q')).toBe(FIRST_PAGE_PROMPT);
  });

  it('percent-encodes everything a query string would otherwise read as structure', () => {
    const tricky = "a & b = c? #1 + 100% it's";
    const claude = claudePromptUrl(tricky);
    expect(claude).toBe(
      'https://claude.ai/new?q=a%20%26%20b%20%3D%20c%3F%20%231%20%2B%20100%25%20it\'s',
    );
    expect(claude).not.toContain(' ');
    expect(new URL(claude).searchParams.get('q')).toBe(tricky);
    expect(new URL(chatGptPromptUrl(tricky)).searchParams.get('q')).toBe(tricky);
    // Nothing after a `#` would ever reach the chat — the fragment stays in the prompt.
    expect(new URL(claude).hash).toBe('');
  });

  it('keeps the prompt short enough for a link', () => {
    expect(claudePromptUrl(FIRST_PAGE_PROMPT).length).toBeLessThan(400);
  });
});

/**
 * Which way in leads is read off the connected agent's name: a link only
 * where the web chat it opens can actually reach the knowledge base.
 */
describe('firstPageRoute', () => {
  it.each(['Claude', 'claude', ' CLAUDE ', 'claude.ai', 'Claude Desktop', 'claude-desktop'])(
    'leads with Claude for %j',
    (client) => {
      expect(firstPageRoute(client, 'agent').primary).toBe('claude');
    },
  );

  it.each(['ChatGPT', 'chatgpt', 'ChatGPT Connector'])('leads with ChatGPT for %j', (client) => {
    expect(firstPageRoute(client, 'agent').primary).toBe('chatgpt');
  });

  it.each(['Claude Code', 'claude code', 'Cursor', 'Windsurf', 'Codex', 'My laptop key', 'Claudette'])(
    'leads with Copy prompt for %j',
    (client) => {
      expect(firstPageRoute(client, 'agent')).toEqual({ primary: 'copy', agentName: client });
    },
  );

  it('leads with Copy prompt for any agent on the local server, Claude included, naming the agent alone', () => {
    expect(firstPageRoute('Claude Code · local server on LAPTOP-1', 'agent')).toEqual({
      primary: 'copy',
      agentName: 'Claude Code',
    });
    expect(firstPageRoute('Claude Desktop · local server on LAPTOP-1', 'agent')).toEqual({
      primary: 'copy',
      agentName: 'Claude Desktop',
    });
    expect(firstPageRoute('Claude · LOCAL SERVER ON mac.local', 'agent')).toEqual({ primary: 'copy', agentName: 'Claude' });
  });

  it('has no name to offer for an unnamed or unknown agent, or none at all', () => {
    expect(firstPageRoute('Unnamed agent', 'agent')).toEqual({ primary: 'copy', agentName: null });
    expect(firstPageRoute('Unknown agent · local server on LAPTOP-1', 'agent')).toEqual({ primary: 'copy', agentName: null });
    expect(firstPageRoute(undefined, 'agent')).toEqual({ primary: 'copy', agentName: null });
    expect(firstPageRoute(null, 'agent')).toEqual({ primary: 'copy', agentName: null });
    expect(firstPageRoute('   ', 'agent')).toEqual({ primary: 'copy', agentName: null });
  });

  it.each(['Claude', 'ChatGPT', 'ChatGPT CLI', 'Claude Desktop', 'My laptop key'])(
    'leads with Copy prompt, naming no agent, for a connection key labelled %j',
    (label) => {
      // A key's label is free text: it names the key, not the app holding it.
      expect(firstPageRoute(label, 'key')).toEqual({ primary: 'copy', agentName: null });
    },
  );

  it('leads with Copy prompt when the answer does not say which kind of connection it is', () => {
    expect(firstPageRoute('Claude', undefined)).toEqual({ primary: 'copy', agentName: null });
    expect(firstPageRoute('ChatGPT', null)).toEqual({ primary: 'copy', agentName: null });
  });
});

describe('firstPagePromptFor', () => {
  it("is the chosen starter pack's own request, without the YAML block's trailing newline", () => {
    expect(firstPagePromptFor({ firstPagePrompt: 'Fill in the Customers page.\n' })).toBe('Fill in the Customers page.');
  });

  it('is the generic request without a pack, or with one that has none to give', () => {
    expect(firstPagePromptFor(null)).toBe(FIRST_PAGE_PROMPT);
    expect(firstPagePromptFor({ firstPagePrompt: '  ' })).toBe(FIRST_PAGE_PROMPT);
  });
});
