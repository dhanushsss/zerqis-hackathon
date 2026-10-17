/**
 * Single source of truth for the displayed product identity. Internal identifiers
 * (ALIBI_* environment variables, API routes, database names, the `.alibi/` work
 * directory, fixture repositories) keep their original names for compatibility.
 */
export const BRAND = {
  name: 'Zerqis',
  tagline: "Don't just explain the failure. Prove it.",
  description:
    'Zerqis investigates failed CI builds through controlled experiments, traces the evidence, and validates candidate fixes before recommending them.',
  /** Short line under the wordmark in the app sidebar. */
  short: 'Evidence-driven CI investigation.',
} as const;

/** Document title for a page: "Section · Zerqis", or the full product title for the home page. */
export function pageTitle(section?: string): string {
  return section ? `${section} · ${BRAND.name}` : `${BRAND.name} — Evidence-driven CI investigation`;
}
