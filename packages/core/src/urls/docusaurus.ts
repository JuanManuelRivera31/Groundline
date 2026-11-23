/**
 * Maps a Docusaurus docs file to its public URL, following the docs plugin
 * rules (https://docusaurus.io/docs/create-doc,
 * https://docusaurus.io/docs/api/plugins/@docusaurus/plugin-content-docs):
 * - URL = siteUrl + baseUrl + routeBasePath + slug;
 * - default slug = file path without extension, number prefixes stripped;
 * - `index`, `README` and a file named like its parent folder map to the folder;
 * - frontmatter `id` replaces the last path segment;
 * - frontmatter `slug` starting with `/` is absolute (relative to routeBasePath),
 *   otherwise it is resolved against the file's folder.
 */
export interface DocusaurusSite {
  /** e.g. "https://plausible.io" */
  readonly siteUrl: string;
  /** e.g. "/docs/" */
  readonly baseUrl: string;
  /** e.g. "/" (Plausible) or "docs" (Docusaurus default) */
  readonly routeBasePath: string;
}

export interface DocFrontmatterRouting {
  readonly id?: unknown;
  readonly slug?: unknown;
}

const NUMBER_PREFIX = /^\d+\s*[-_.]+\s*(?=[^-_.\s])/;

function stripNumberPrefix(segment: string): string {
  return segment.replace(NUMBER_PREFIX, '');
}

function resolveSegments(segments: readonly string[]): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out;
}

export function docusaurusDocUrl(relativePath: string, frontmatter: DocFrontmatterRouting, site: DocusaurusSite): string {
  const withoutExt = relativePath.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\.mdx?$/i, '');
  const segments = withoutExt.split('/').map(stripNumberPrefix);
  const fileName = segments.pop() ?? '';
  const folders = segments;

  let routeSegments: string[];
  if (typeof frontmatter.slug === 'string' && frontmatter.slug.trim() !== '') {
    const slug = frontmatter.slug.trim();
    routeSegments = slug.startsWith('/') ? resolveSegments(slug.split('/')) : resolveSegments([...folders, ...slug.split('/')]);
  } else {
    const parent = folders[folders.length - 1];
    const lower = fileName.toLowerCase();
    const isCategoryIndex = lower === 'index' || lower === 'readme' || lower === parent?.toLowerCase();
    const last = typeof frontmatter.id === 'string' && frontmatter.id.trim() !== '' ? frontmatter.id.trim() : fileName;
    routeSegments = isCategoryIndex && typeof frontmatter.id !== 'string' ? [...folders] : [...folders, last];
  }

  const path = ['', site.baseUrl, site.routeBasePath, ...routeSegments]
    .join('/')
    .replace(/\/{2,}/g, '/')
    .replace(/(.)\/$/, '$1');
  return `${site.siteUrl.replace(/\/+$/, '')}${path}`;
}

/** Appends a heading anchor to a page URL. */
export function withAnchor(url: string, anchor: string | null | undefined): string {
  return anchor ? `${url}#${anchor}` : url;
}
