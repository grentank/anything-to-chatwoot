/**
 * Render a small subset of Markdown (as produced by Chatwoot agents) into the
 * HTML subset that Telegram accepts. Anything not recognized is HTML-escaped so
 * the message can never break Telegram's parser.
 */

export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PLACEHOLDER = '\u0000';

export function markdownToTelegramHtml(input: string): string {
  if (!input) return '';

  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Protect fenced code blocks (```...```), keeping their content verbatim.
  let text = input.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, code: string) => {
    const idx = codeBlocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ''))}</pre>`) - 1;
    return `${PLACEHOLDER}CB${idx}${PLACEHOLDER}`;
  });

  // 2. Protect inline code (`...`).
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = inlineCodes.push(`<code>${escapeHtml(code)}</code>`) - 1;
    return `${PLACEHOLDER}IC${idx}${PLACEHOLDER}`;
  });

  // 3. Escape everything else.
  text = escapeHtml(text);

  // 4. Links: [label](url)
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );

  // 5. Bold: **text** or __text__
  text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^_]+)__/g, '<b>$1</b>');

  // 6. Italic: *text* or _text_ (avoid touching the bold markers already consumed)
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  text = text.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<i>$2</i>');

  // 7. Strikethrough: ~~text~~
  text = text.replace(/~~([^~]+)~~/g, '<s>$1</s>');

  // 8. Restore protected code.
  text = text.replace(
    new RegExp(`${PLACEHOLDER}IC(\\d+)${PLACEHOLDER}`, 'g'),
    (_m, i: string) => inlineCodes[Number(i)],
  );
  text = text.replace(
    new RegExp(`${PLACEHOLDER}CB(\\d+)${PLACEHOLDER}`, 'g'),
    (_m, i: string) => codeBlocks[Number(i)],
  );

  return text;
}
