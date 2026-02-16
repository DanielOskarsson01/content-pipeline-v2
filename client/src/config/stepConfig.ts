// R009 fix: local copy of STEP_CONFIG (was importing from ../../../shared/ outside src/).
// Source of truth: SKELETON_SPEC_v2.md Part 5. Keep in sync.
export const STEP_CONFIG = [
  { index: 0, name: "Project Start", description: "Define project scope and metadata" },
  { index: 1, name: "Discovery", description: "Find candidate sources and seed data" },
  { index: 2, name: "Validation", description: "Filter before committing to expensive operations" },
  { index: 3, name: "Scraping", description: "Fetch actual content from validated sources" },
  { index: 4, name: "Filtering & Assembly", description: "Clean and organize into source packages" },
  { index: 5, name: "Analysis & Generation", description: "Produce output content from sources" },
  { index: 6, name: "Quality Assurance", description: "Verify output meets standards" },
  { index: 7, name: "Routing", description: "Decide what happens to items that fail QA" },
  { index: 8, name: "Bundling", description: "Package into delivery formats" },
  { index: 9, name: "Distribution", description: "Push to external systems" },
  { index: 10, name: "Review", description: "Final human gate before publication" },
] as const;

export type StepIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
