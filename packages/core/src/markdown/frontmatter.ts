import { parse } from 'yaml';

export interface FrontmatterResult {
  readonly data: Readonly<Record<string, unknown>>;
  /** Document body with normalized `\n` line endings. */
  readonly body: string;
}

// U+FEFF (byte order mark), built from its code point to keep the source ASCII-only.
const BOM = String.fromCharCode(0xfeff);
const LEADING_BOM = new RegExp(`^${BOM}`);
const FRONTMATTER = new RegExp(String.raw`^${BOM}?---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)`);

/** Normalizes line endings and splits YAML frontmatter from the body. */
export function splitFrontmatter(source: string): FrontmatterResult {
  const text = source.replace(/\r\n?/g, '\n');
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text.replace(LEADING_BOM, '') };

  const parsed: unknown = parse(match[1] ?? '');
  const data =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { data, body: text.slice(match[0].length) };
}

/** Reads a string-valued frontmatter field, ignoring other types. */
export function frontmatterString(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
