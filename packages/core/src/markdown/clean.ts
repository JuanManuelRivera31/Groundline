/**
 * Cleans a prose segment of a Markdown/MDX document (never a fenced code
 * block): drops imports/exports, comments, <head>/<script>/<style> blocks,
 * JSX/HTML tags and JSX expressions, keeps the text children of tags, keeps
 * non-empty image alt text and reduces links to their text. Inline code spans
 * are protected and restored verbatim.
 */

const PLACEHOLDER = '\u0000';
const ESCAPED_OPEN = '\u0001';
const ESCAPED_CLOSE = '\u0002';

// Balanced braces up to two levels deep, e.g. {useBaseUrl('/img/a.png')} or {{a: 1}}.
const BRACES = String.raw`\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}`;
const ATTRS = String.raw`(?:[^<>{}"']|"[^"]*"|'[^']*'|${BRACES})*`;

const INLINE_CODE = /(`+)((?:[^`\n]|\n(?![ \t]*\n))+?)\1(?!`)/g;
const MDX_HEADING_ID = /\{\/\*\s*#([\w-]+)\s*\*\/\}/g;
const MDX_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const DROPPED_ELEMENTS = /<(head|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const IMPORT_MULTILINE = /^[ \t]*import\s+(?:[\w$*\s,]*\{[\s\S]*?\}[\w$*\s,]*)\s*from\s*['"][^'"\n]+['"];?[ \t]*$/gm;
const IMPORT_LINE = /^[ \t]*import\s[^\n]*?['"][^'"\n]+['"];?[ \t]*$/gm;
const EXPORT_LINE = /^[ \t]*export\s+(?:default\s+)?(?:const|let|var|function|class)\b[^\n]*$/gm;
const MD_IMAGE = /!\[([^\]]*)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g;
const MD_LINK = /\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g;
const MD_REF_LINK = /\[([^\]]+)\]\[[^\]]*\]/g;
const LINK_DEFINITION = /^[ \t]{0,3}\[[^\]]+\]:[ \t]+\S+.*$/gm;
const IMG_TAG = new RegExp(String.raw`<img\b(${ATTRS})\/?>`, 'gi');
const ALT_ATTR = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/i;
const TAG = new RegExp(String.raw`<\/?[A-Za-z][\w.:-]*(?:\s${ATTRS})?\s*\/?>`, 'g');
const FRAGMENT = /<\/?>/g;
const EXPRESSION = new RegExp(String.raw`\{(?!#)(?:[^{}]|${BRACES})*\}`, 'g');

const ENTITIES: Readonly<Record<string, string>> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

export function cleanProse(text: string): string {
  const codeSpans: string[] = [];
  let out = text.replace(INLINE_CODE, (span) => {
    codeSpans.push(span);
    return `${PLACEHOLDER}${codeSpans.length - 1}${PLACEHOLDER}`;
  });

  out = out.replace(/\\\{/g, ESCAPED_OPEN).replace(/\\\}/g, ESCAPED_CLOSE);

  out = out
    .replace(MDX_HEADING_ID, '{#$1}')
    .replace(MDX_COMMENT, '')
    .replace(HTML_COMMENT, '')
    .replace(DROPPED_ELEMENTS, '')
    .replace(IMPORT_MULTILINE, '')
    .replace(IMPORT_LINE, '')
    .replace(EXPORT_LINE, '')
    .replace(MD_IMAGE, (_m, alt: string) => alt.trim())
    .replace(MD_LINK, '$1')
    .replace(MD_REF_LINK, '$1')
    .replace(LINK_DEFINITION, '')
    .replace(IMG_TAG, (_m, attrs: string) => {
      const alt = ALT_ATTR.exec(attrs);
      return (alt?.[1] ?? alt?.[2] ?? alt?.[3] ?? '').trim();
    })
    .replace(TAG, '')
    .replace(FRAGMENT, '')
    .replace(EXPRESSION, '');

  out = out.replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g, (entity) => ENTITIES[entity] ?? entity);
  out = out.replaceAll(ESCAPED_OPEN, '{').replaceAll(ESCAPED_CLOSE, '}');
  out = out.replace(/[ \t]+$/gm, '');

  return out.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'), (_m, index: string) => {
    return codeSpans[Number(index)] ?? '';
  });
}
