/**
 * Shared submodule ordering utilities.
 *
 * Defines the canonical category execution order and provides a sort function
 * used by progressive save, from-run template creation, and auto-execute fallback.
 */

import { getSubmoduleById } from './moduleLoader.js';

export const CATEGORY_ORDER = {
  crawling: 1, news: 2, filtering: 3, scraping: 4, analysis: 5,
  planning: 6, generation: 7, seo: 8, review: 9, qa: 10,
  formatting: 11, bundling: 12, media: 13, data: 14, website: 15, testing: 16,
};

/**
 * Sort an array of submodule IDs by their registry category + sort_order.
 * Unknown submodules are pushed to the end.
 */
export function sortSubmoduleIds(ids) {
  return [...ids].sort((a, b) => {
    const mA = getSubmoduleById(a);
    const mB = getSubmoduleById(b);
    const catA = CATEGORY_ORDER[mA?.category] ?? 99;
    const catB = CATEGORY_ORDER[mB?.category] ?? 99;
    if (catA !== catB) return catA - catB;
    return (mA?.sort_order ?? 99) - (mB?.sort_order ?? 99);
  });
}
