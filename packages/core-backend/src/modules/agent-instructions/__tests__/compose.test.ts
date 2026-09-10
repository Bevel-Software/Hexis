import { describe, expect, it } from 'vitest';
import {
  PLATFORM_HEADER,
  PREAMBLE_CAP,
  PREAMBLE_TRUNCATION_MARKER,
  TOOL_PREFIX_CAP,
  TOOL_PREFIX_LINE,
  composeAgentInstructions,
  prefixToolDescription,
} from '../compose.js';

/**
 * The composer is pure, so every rule of the two texts is pinned here: what
 * an absent or empty preamble yields, how comments are withheld, where both
 * caps cut, and that a cut never splits a character.
 */

describe('composeAgentInstructions: the handshake text', () => {
  it('sends the header alone for an absent, empty, whitespace or comment-only preamble', () => {
    for (const raw of [null, '', '   \n\n', '<!-- notes to myself -->', '<!--\nline one\nline two\n-->\n']) {
      const out = composeAgentInstructions(raw);
      expect(out.instructions, JSON.stringify(raw)).toBe(PLATFORM_HEADER);
      expect(out.toolPrefix).toBe(TOOL_PREFIX_LINE);
      expect(out.truncated).toBe(false);
      expect(out.toolPrefixTruncated).toBe(false);
      expect(out.preambleChars).toBe(0);
      expect(out.unterminatedComment).toBe(false);
    }
  });

  it('is the header, a blank line, then the preamble body', () => {
    const out = composeAgentInstructions('We sell permits.\n\nLook in Permitting/ first.\n');
    expect(out.instructions).toBe(`${PLATFORM_HEADER}\n\nWe sell permits.\n\nLook in Permitting/ first.`);
    expect(out.preambleChars).toBe('We sell permits.\n\nLook in Permitting/ first.'.length);
  });

  it('hands the two parts and the fixed prefix line back separately, for the card', () => {
    const out = composeAgentInstructions('We sell permits.');
    expect(out.header).toBe(PLATFORM_HEADER);
    expect(out.preamble).toBe('We sell permits.');
    expect(out.toolPrefixLine).toBe(TOOL_PREFIX_LINE);
    expect(out.toolPrefix.startsWith(out.toolPrefixLine)).toBe(true);
    expect(composeAgentInstructions(null).preamble).toBe('');
    // The preamble part carries the marker when cut, exactly as sent.
    expect(composeAgentInstructions('x'.repeat(PREAMBLE_CAP + 1)).preamble.endsWith(PREAMBLE_TRUNCATION_MARKER)).toBe(true);
  });

  it('withholds every HTML comment from both outputs', () => {
    const out = composeAgentInstructions('<!-- private: do not send -->Public line.<!-- more notes -->\n\nSecond paragraph.');
    expect(out.instructions).not.toContain('private');
    expect(out.instructions).not.toContain('more notes');
    expect(out.instructions).toContain('Public line.');
    expect(out.toolPrefix).toBe(`${TOOL_PREFIX_LINE} Public line.`);
    expect(out.unterminatedComment).toBe(false);
  });

  it('an unterminated comment withholds everything after it and is reported', () => {
    const out = composeAgentInstructions('Visible.\n\n<!-- forgot to close\nSecret folder names\n');
    expect(out.instructions).toBe(`${PLATFORM_HEADER}\n\nVisible.`);
    expect(out.instructions).not.toContain('Secret');
    expect(out.toolPrefix).toBe(`${TOOL_PREFIX_LINE} Visible.`);
    expect(out.unterminatedComment).toBe(true);
  });

  it('sends exactly the cap whole, and cuts one past it with the marker', () => {
    const exact = 'a'.repeat(PREAMBLE_CAP);
    const atCap = composeAgentInstructions(exact);
    expect(atCap.truncated).toBe(false);
    expect(atCap.instructions).toBe(`${PLATFORM_HEADER}\n\n${exact}`);
    expect(atCap.instructions).not.toContain('truncated');

    const over = composeAgentInstructions(`${exact}b`);
    expect(over.truncated).toBe(true);
    expect(over.instructions).toBe(`${PLATFORM_HEADER}\n\n${exact}\n${PREAMBLE_TRUNCATION_MARKER}`);
    expect(PREAMBLE_TRUNCATION_MARKER).toContain('6,000');
    expect(PREAMBLE_TRUNCATION_MARKER).toContain('mcp-description.md');
  });

  it('reports the count before truncation', () => {
    const out = composeAgentInstructions('x'.repeat(PREAMBLE_CAP + 1234));
    expect(out.preambleChars).toBe(PREAMBLE_CAP + 1234);
    expect(out.truncated).toBe(true);
  });

  it('counts after comment stripping, not the raw file', () => {
    const out = composeAgentInstructions('<!-- a very long private note -->Short.');
    expect(out.preambleChars).toBe('Short.'.length);
  });

  it('a cut that would split a surrogate pair moves before it', () => {
    // 5,999 ASCII units, then an astral character (two UTF-16 units): unit
    // 6,000 is its high surrogate, so the cut must land before it.
    const raw = `${'a'.repeat(PREAMBLE_CAP - 1)}😀tail`;
    const out = composeAgentInstructions(raw);
    expect(out.truncated).toBe(true);
    const body = out.instructions.slice(PLATFORM_HEADER.length + 2);
    const sent = body.slice(0, body.indexOf('\n'));
    expect(sent).toBe('a'.repeat(PREAMBLE_CAP - 1));
    expect(sent.length).toBe(PREAMBLE_CAP - 1);
    // Nothing in what was sent is a lone surrogate.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out.instructions)).toBe(false);
  });
});

describe('composeAgentInstructions: the tool prefix', () => {
  it('starts with the fixed line, then the first paragraph, collapsed to one line', () => {
    const out = composeAgentInstructions('Acme builds solar\nfarms in Spain.\n\nSecond paragraph.');
    expect(out.toolPrefix).toBe(`${TOOL_PREFIX_LINE} Acme builds solar farms in Spain.`);
    expect(out.toolPrefixChars).toBe(out.toolPrefix.length);
    expect(out.toolPrefixTruncated).toBe(false);
  });

  it('skips headings: a heading-led file still yields the first real paragraph', () => {
    const out = composeAgentInstructions('# Acme knowledge base\n\n## Scope\n\nWhat we know about permits.\n');
    expect(out.toolPrefix).toBe(`${TOOL_PREFIX_LINE} What we know about permits.`);
    // A heading directly above text in the same block is dropped, not merged.
    const tight = composeAgentInstructions('## Scope\nWhat we know about permits.');
    expect(tight.toolPrefix).toBe(`${TOOL_PREFIX_LINE} What we know about permits.`);
  });

  it('falls back to the fixed line alone for an empty or heading-only preamble', () => {
    for (const raw of [null, '', '# Only a title\n\n## And a subtitle', 'Setext title\n===\n\nAnother\n---', '---\n\n***']) {
      expect(composeAgentInstructions(raw).toolPrefix, JSON.stringify(raw)).toBe(TOOL_PREFIX_LINE);
    }
  });

  it('skips setext headings and thematic breaks the same way it skips ATX headings', () => {
    expect(composeAgentInstructions('Acme knowledge base\n===\n\nWhat we know about permits.').toolPrefix).toBe(
      `${TOOL_PREFIX_LINE} What we know about permits.`,
    );
    // The underline directly above text in the same block heads only what is above it.
    expect(composeAgentInstructions('Scope\n---\nWhat we know about permits.').toolPrefix).toBe(
      `${TOOL_PREFIX_LINE} What we know about permits.`,
    );
    expect(composeAgentInstructions('---\n\nAfter the rule.').toolPrefix).toBe(`${TOOL_PREFIX_LINE} After the rule.`);
    // A lone dash line is a rule, not an underline: it never swallows text above it.
    expect(composeAgentInstructions('- - -\n\nList-looking rule first.').toolPrefix).toBe(
      `${TOOL_PREFIX_LINE} List-looking rule first.`,
    );
  });

  it('a rule after a list item is a thematic break, not the underline of a setext heading', () => {
    // CommonMark: the underline cannot be a lazy continuation of a list item or a
    // blockquote, so the item survives and the rule is dropped like any other.
    expect(composeAgentInstructions('- Permits\n---\n\nWhat we know about permits.').toolPrefix).toBe(
      `${TOOL_PREFIX_LINE} - Permits`,
    );
    expect(composeAgentInstructions('> Permits\n---\n\nWhat we know about permits.').toolPrefix).toBe(
      `${TOOL_PREFIX_LINE} > Permits`,
    );
    // The lines that continue an item or a quote belong to it, so a rule beneath them is a break too.
    expect(composeAgentInstructions('- Item one\n  continuation\n---\n\nWhat we know.').toolPrefix).toBe(
      `${TOOL_PREFIX_LINE} - Item one continuation`,
    );
    expect(composeAgentInstructions('> quote\ncontinued\n---\n\nWhat we know.').toolPrefix).toBe(
      `${TOOL_PREFIX_LINE} > quote continued`,
    );
    // A bare `===` beneath a container is literal text to CommonMark, but a line of rule characters is never content worth sending.
    expect(composeAgentInstructions('- Item\nPara\n===\n\nWhat we know.').toolPrefix).toBe(`${TOOL_PREFIX_LINE} - Item Para`);
  });

  it('a spaced thematic break is a break, not a list item, so the setext heading beneath it is still dropped', () => {
    expect(composeAgentInstructions('* * *\nTitle\n===\n\nWhat we know.').toolPrefix).toBe(`${TOOL_PREFIX_LINE} What we know.`);
    expect(composeAgentInstructions('- - -\nTitle\n---\n\nWhat we know.').toolPrefix).toBe(`${TOOL_PREFIX_LINE} What we know.`);
  });

  it('a fenced code block is not a paragraph: a rule inside it is code, and the prose after it is the prefix', () => {
    expect(
      composeAgentInstructions('```yaml\nkey: value\n---\nother: value\n```\n\nWhat we know about permits.').toolPrefix,
    ).toBe(`${TOOL_PREFIX_LINE} What we know about permits.`);
    // Blank lines inside the fence do not end it; only a closing fence does.
    expect(composeAgentInstructions('~~~\nfoo\n\n---\n~~~\nAfter the block.').toolPrefix).toBe(
      `${TOOL_PREFIX_LINE} After the block.`,
    );
    // A fence that never closes runs to the end of the file, as in CommonMark.
    expect(composeAgentInstructions('```\nnever closed\n\nstill code').toolPrefix).toBe(TOOL_PREFIX_LINE);
  });

  it('indentation decides what is a fence: three columns still open one, four make it indented code', () => {
    // A ``` indented four columns is the content of an indented code block,
    // not a fence — so it cannot swallow the prose after it as an unclosed
    // one. At the very start of the file too: the text is classified before
    // it is trimmed, so the first line keeps the indentation that makes it code.
    expect(composeAgentInstructions('    ```\n    looks like a fence\n\nProse after the code.').toolPrefix).toBe(
      `${TOOL_PREFIX_LINE} Prose after the code.`,
    );
    // An indented code block is not a paragraph, whatever it says — at the
    // start, after a heading, after a setext heading and after a rule, with
    // or without a blank line between: each of those ends what came before.
    expect(composeAgentInstructions('    code line\n\tanother\n\nProse.').toolPrefix).toBe(`${TOOL_PREFIX_LINE} Prose.`);
    expect(composeAgentInstructions('# Title\n    code\n\nProse.').toolPrefix).toBe(`${TOOL_PREFIX_LINE} Prose.`);
    expect(composeAgentInstructions('Title\n===\n    code\nProse.').toolPrefix).toBe(`${TOOL_PREFIX_LINE} Prose.`);
    expect(composeAgentInstructions('---\n    code\n\nProse.').toolPrefix).toBe(`${TOOL_PREFIX_LINE} Prose.`);
    // Up to three columns the fence is a fence, and so is its closer.
    expect(composeAgentInstructions('   ```\n---\n   ```\nProse.').toolPrefix).toBe(`${TOOL_PREFIX_LINE} Prose.`);
    // Inside a paragraph, indentation is a continuation, not code.
    expect(composeAgentInstructions('First line\n    continued.\n\nNext.').toolPrefix).toBe(
      `${TOOL_PREFIX_LINE} First line continued.`,
    );
  });

  it("a fence closes only on a line of the opener's character, at least as long", () => {
    // Mixed characters do not close it, so what follows stays code.
    expect(composeAgentInstructions('```\ncode\n```~\nmore code\n```\n\nProse.').toolPrefix).toBe(
      `${TOOL_PREFIX_LINE} Prose.`,
    );
    // A shorter run does not close it; a longer one does.
    expect(composeAgentInstructions('````\ncode\n```\nstill code\n`````\n\nProse.').toolPrefix).toBe(
      `${TOOL_PREFIX_LINE} Prose.`,
    );
  });

  it('CRLF input still yields the first paragraph', () => {
    const out = composeAgentInstructions('# Title\r\n\r\nFirst paragraph.\r\n\r\nSecond.\r\n');
    expect(out.toolPrefix).toBe(`${TOOL_PREFIX_LINE} First paragraph.`);
    expect(out.instructions).toBe(`${PLATFORM_HEADER}\n\n# Title\n\nFirst paragraph.\n\nSecond.`);
  });

  it('is at most the cap, still starting with the fixed line, and reports the count before the cut', () => {
    const long = 'w'.repeat(TOOL_PREFIX_CAP * 2);
    const out = composeAgentInstructions(long);
    expect(out.toolPrefix.length).toBe(TOOL_PREFIX_CAP);
    expect(out.toolPrefix.startsWith(TOOL_PREFIX_LINE)).toBe(true);
    expect(out.toolPrefixTruncated).toBe(true);
    expect(out.toolPrefixChars).toBe(TOOL_PREFIX_LINE.length + 1 + long.length);
  });

  it('never splits a surrogate pair at the prefix cap', () => {
    // Pad so that unit 300 of the prefix is the high surrogate of an astral character.
    const padding = 'p'.repeat(TOOL_PREFIX_CAP - TOOL_PREFIX_LINE.length - 2);
    const out = composeAgentInstructions(`${padding}😀zz`);
    expect(out.toolPrefixTruncated).toBe(true);
    expect(out.toolPrefix.length).toBe(TOOL_PREFIX_CAP - 1);
    expect(out.toolPrefix.endsWith(padding)).toBe(true);
  });
});

describe('prefixToolDescription', () => {
  it('is the prefix, a blank line, then the original description', () => {
    expect(prefixToolDescription('P', 'Read a file.')).toBe('P\n\nRead a file.');
  });

  it('is the prefix alone for a tool with no description', () => {
    expect(prefixToolDescription('P', undefined)).toBe('P');
    expect(prefixToolDescription('P', '')).toBe('P');
  });
});
