# ADR-0005: Demo corpus — Plausible Analytics documentation

- Status: Accepted
- Date: 2026-11-22

## Context

The demo needs a realistic, openly licensed support corpus with billing, integration and troubleshooting content and stable public URLs to cite.

## Decision

- **Corpus**: https://github.com/plausible/docs (Docusaurus), licensed **CC BY-SA 4.0** (`LICENSE.md`).
- **Pinned commit**: `e9a092a987cffc3b29fd546d7cda17534860b83b` (branch `master`, 2026-11-20), declared in `apps/ingest/src/sources/plausible.ts`.
  - `pnpm ingest --source plausible` makes a blobless partial clone into `data/corpus/plausible`, fetches the pinned commit and checks it out detached, then verifies `HEAD`.
  - The corpus is **never committed** (`data/` is gitignored).
  - The commit is stored in `sources.pinned_commit`, `documents.commit_sha` and `ingest_runs.commit_sha`.
- **URL mapping** follows the repo's `docusaurus.config.js`: `url: 'https://plausible.io'`, `baseUrl: '/docs/'`, docs `routeBasePath: '/'`, `trailingSlash: false`.
  - `docs/<path>.md` → `https://plausible.io/docs/<path>`.
  - Frontmatter `slug`/`id`, number prefixes and `index`/`README` category files are handled per the Docusaurus rules. None are used in the pinned commit.
  - Files and folders starting with `_` are skipped as partials, and `draft: true` pages are skipped.
  - Example mappings:
    - https://plausible.io/docs/cancel-subscription
    - https://plausible.io/docs/shopify-integration
    - https://plausible.io/docs/ecommerce-revenue-tracking
    - https://plausible.io/docs/custom-props/introduction
    - https://plausible.io/docs/billing
- **Attribution**: README and NOTICE credit Plausible Analytics and the CC BY-SA 4.0 license, and state: "Unofficial demo. Not affiliated with or endorsed by Plausible Analytics."
  - Chunks derived from the docs keep their source URL. Any redistributed derivative of the corpus (none in this repository) would have to be CC BY-SA 4.0.

## Consequences

- Bumping the corpus is a one-line change to the pinned commit, plus a re-ingest that only re-embeds changed chunks.
- The kit's own code stays MIT. The corpus is downloaded data, not part of the repository.

## Sources

- Repository and license: https://github.com/plausible/docs · https://github.com/plausible/docs/blob/master/LICENSE.md
- Site config: https://github.com/plausible/docs/blob/master/docusaurus.config.js
- Docusaurus doc URLs, `id`/`slug`, partials: https://docusaurus.io/docs/create-doc · https://docusaurus.io/docs/api/plugins/@docusaurus/plugin-content-docs
- CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/
