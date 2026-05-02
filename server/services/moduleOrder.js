/**
 * Shared submodule ordering utilities.
 *
 * Defines the canonical category execution order and provides a sort function
 * used by progressive save, from-run template creation, and auto-execute fallback.
 */

import { getSubmoduleById } from './moduleLoader.js';

export const CATEGORY_ORDER = {
  website: 1, crawling: 2, search: 3, news: 4, filtering: 5, scraping: 6, analysis: 7,
  planning: 8, generation: 9, seo: 10, review: 11, qa: 12,
  formatting: 13, bundling: 14, media: 15, data: 16, testing: 17,
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
