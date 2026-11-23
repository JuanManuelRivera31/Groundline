# ADR-0004: Markdown/MDX-aware chunking

- Status: Accepted
- Date: 2026-11-22

## Context

Answers must cite a precise source, so chunks need to align with document sections and carry a stable `url#anchor`. Docusaurus docs mix Markdown with MDX: imports, JSX components, `{expressions}`, `<head>` blocks and admonitions.

## Decision

- A **dependency-free scanner** in `packages/core`, rather than a full MDX parser. It never fails on a malformed component, and every rule is explicit and unit-tested. It works in three passes:
  1. It splits fenced code blocks (``` and ~~~, any indentation) from prose. Code is kept verbatim.
  2. It cleans the prose:
     - Inline code spans are protected first.
     - Removed: `import`/`export` lines, HTML/MDX comments, `<head>`/`<script>`/`<style>` elements, JSX/HTML tags and `{expressions}`.
     - Kept: tag text children (e.g. `<details><summary>`) and non-empty image `alt` text.
     - Links become their text; `\{ \}` escapes survive.
  3. It scans lines into blocks: headings (with explicit ids in both `{#id}` and `{/* #id */}` form), tables, admonitions (`:::tip Title` → "Tip: Title" + body) and paragraphs.
- **Sections**:
  - Every heading opens a section. Its `heading_path` always starts with the document title (frontmatter `title`, else the first H1, else the file name), e.g. "Billing FAQ > How long does a refund take?".
  - An H1 equal to the title is the document top: its anchor is null, so the citation URL has no fragment.
  - Anchors use `github-slugger` per document (duplicates become `-1`, `-2`), matching Docusaurus' heading ids.
  - **A section with no body is never emitted alone**; it merges into the next section. Its heading survives either in the next heading path (when it is an ancestor) or as a heading line at the start of the next chunk. A trailing empty section is dropped.
- **Packing**:
  - Blocks are packed greedily up to **500 estimated tokens** per chunk, heading path included, aiming for the 350–500 range on long sections.
  - Code blocks and tables are atomic and never cut; if one is bigger than the budget it becomes its own chunk.
  - Oversized prose splits by lines, then sentences, then words.
  - Consecutive chunks of the same section overlap by up to **60 tokens** (trailing sentences of the previous chunk).
  - A tail under 120 tokens merges back into the previous chunk when the result stays within the budget. Only an atomic code block or table can exceed 500 tokens.
- **Embed text** = `heading_path + "\n\n" + content`. `content` (without the path) is what users see and what is indexed together with `heading_path` for full-text search.
- Tokens are estimated as `ceil(chars / 4)`. Exact counting would spend API quota.

## Consequences

- Short sections (e.g. one-line FAQ answers) produce small chunks; they are kept for citation precision. `pnpm chunks:stats` reports the token distribution so this can be tuned with evals in S2+.
- The scanner covers the constructs found in the demo corpus. A new construct needs a rule and a test.

## Sources

- Docusaurus heading ids and explicit id syntax: https://docusaurus.io/docs/markdown-features/toc#heading-ids
- Docusaurus admonitions: https://docusaurus.io/docs/markdown-features/admonitions
- github-slugger: https://github.com/Flet/github-slugger
