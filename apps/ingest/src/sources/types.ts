import type { DocusaurusSite } from '@groundline/core';

export interface SourceDefinition {
  readonly key: string;
  readonly name: string;
  readonly repoUrl: string;
  /** Pinned commit; bump deliberately and record it in the ADR/README. */
  readonly commit: string;
  /** Docs root inside the repository. */
  readonly docsDir: string;
  readonly license: string;
  readonly site: DocusaurusSite;
}
