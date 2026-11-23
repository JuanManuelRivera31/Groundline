import { describe, expect, it } from 'vitest';
import { docusaurusDocUrl, withAnchor, type DocusaurusSite } from '../src/urls/docusaurus.ts';

const plausible: DocusaurusSite = { siteUrl: 'https://plausible.io', baseUrl: '/docs/', routeBasePath: '/' };
const defaults: DocusaurusSite = { siteUrl: 'https://example.com/', baseUrl: '/', routeBasePath: 'docs' };

describe('docusaurusDocUrl', () => {
  it.each([
    ['cancel-subscription.md', 'https://plausible.io/docs/cancel-subscription'],
    ['custom-props/introduction.md', 'https://plausible.io/docs/custom-props/introduction'],
    ['proxy/guides/cloudflare.md', 'https://plausible.io/docs/proxy/guides/cloudflare'],
    ['guides\\windows-path.mdx', 'https://plausible.io/docs/guides/windows-path'],
  ])('maps %s to %s', (path, url) => {
    expect(docusaurusDocUrl(path, {}, plausible)).toBe(url);
  });

  it('maps index, README and same-name-as-folder files to the folder URL', () => {
    expect(docusaurusDocUrl('proxy/index.md', {}, plausible)).toBe('https://plausible.io/docs/proxy');
    expect(docusaurusDocUrl('proxy/README.md', {}, plausible)).toBe('https://plausible.io/docs/proxy');
    expect(docusaurusDocUrl('guides/Guides.md', {}, plausible)).toBe('https://plausible.io/docs/guides');
    expect(docusaurusDocUrl('index.md', {}, plausible)).toBe('https://plausible.io/docs');
  });

  it('applies absolute and relative slugs', () => {
    expect(docusaurusDocUrl('a/b/page.md', { slug: '/top-level' }, plausible)).toBe('https://plausible.io/docs/top-level');
    expect(docusaurusDocUrl('a/b/page.md', { slug: 'renamed' }, plausible)).toBe('https://plausible.io/docs/a/b/renamed');
    expect(docusaurusDocUrl('a/b/page.md', { slug: '../up' }, plausible)).toBe('https://plausible.io/docs/a/up');
  });

  it('lets frontmatter id replace the last path segment', () => {
    expect(docusaurusDocUrl('guides/long-file-name.md', { id: 'short' }, plausible)).toBe('https://plausible.io/docs/guides/short');
  });

  it('strips number prefixes and honours routeBasePath', () => {
    expect(docusaurusDocUrl('01-getting-started/02_install.md', {}, defaults)).toBe('https://example.com/docs/getting-started/install');
  });

  it('ignores non-string slug/id values', () => {
    expect(docusaurusDocUrl('page.md', { slug: 3, id: null }, plausible)).toBe('https://plausible.io/docs/page');
  });
});

describe('withAnchor', () => {
  it('appends anchors only when present', () => {
    expect(withAnchor('https://plausible.io/docs/billing', 'refunds')).toBe('https://plausible.io/docs/billing#refunds');
    expect(withAnchor('https://plausible.io/docs/billing', null)).toBe('https://plausible.io/docs/billing');
  });
});
