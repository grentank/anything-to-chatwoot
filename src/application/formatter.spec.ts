import { describe, expect, it } from 'vitest';
import { escapeHtml, markdownToTelegramHtml } from './formatter';

describe('escapeHtml', () => {
  it('escapes HTML-significant characters', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

describe('markdownToTelegramHtml', () => {
  it('returns empty string for empty input', () => {
    expect(markdownToTelegramHtml('')).toBe('');
  });

  it('escapes plain text', () => {
    expect(markdownToTelegramHtml('5 < 10 & true')).toBe('5 &lt; 10 &amp; true');
  });

  it('converts bold', () => {
    expect(markdownToTelegramHtml('hello **world**')).toBe('hello <b>world</b>');
    expect(markdownToTelegramHtml('__strong__')).toBe('<b>strong</b>');
  });

  it('converts italic', () => {
    expect(markdownToTelegramHtml('an *emphasis* here')).toBe('an <i>emphasis</i> here');
    expect(markdownToTelegramHtml('an _emphasis_ here')).toBe('an <i>emphasis</i> here');
  });

  it('converts strikethrough', () => {
    expect(markdownToTelegramHtml('~~gone~~')).toBe('<s>gone</s>');
  });

  it('converts inline code and escapes its content', () => {
    expect(markdownToTelegramHtml('use `a < b`')).toBe('use <code>a &lt; b</code>');
  });

  it('converts fenced code blocks verbatim (escaped)', () => {
    const out = markdownToTelegramHtml('```\nif (a < b) {}\n```');
    expect(out).toBe('<pre>if (a &lt; b) {}</pre>');
  });

  it('does not apply markdown inside code', () => {
    expect(markdownToTelegramHtml('`**not bold**`')).toBe('<code>**not bold**</code>');
  });

  it('converts links and keeps the url', () => {
    expect(markdownToTelegramHtml('[site](https://example.com)')).toBe(
      '<a href="https://example.com">site</a>',
    );
  });
});
