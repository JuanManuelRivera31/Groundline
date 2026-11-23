import type { SourceDefinition } from './types.ts';

/**
 * Plausible Analytics documentation (CC BY-SA 4.0), used as the demo corpus.
 * Unofficial demo. Not affiliated with or endorsed by Plausible Analytics.
 * See docs/adr/0005-demo-corpus-plausible-docs.md.
 */
export const plausible: SourceDefinition = {
  key: 'plausible',
  name: 'Plausible Analytics docs',
  repoUrl: 'https://github.com/plausible/docs.git',
  commit: 'e9a092a987cffc3b29fd546d7cda17534860b83b',
  docsDir: 'docs',
  license: 'CC-BY-SA-4.0',
  site: {
    siteUrl: 'https://plausible.io',
    baseUrl: '/docs/',
    routeBasePath: '/',
  },
};
