import { create } from 'zustand';

export type PanelAccordion = 'input' | 'options' | 'results' | null;

/**
 * Panel UI Store - UI state only
 *
 * ARCHITECTURE NOTE: This store only holds panel visibility and accordion state.
 * Domain data (results, run IDs) comes from TanStack Query mutations.
 * Form state (CSV, options) should be local useState in components.
 */
interface PanelStore {
  // Panel visibility
  submodulePanelOpen: boolean;
  activeSubmoduleId: string | null;
  activeCategoryKey: string | null;

  // Active submodule run ID — for polling resume on panel reopen
  activeSubmoduleRunId: string | null;

  // Accordion state
  panelAccordion: PanelAccordion;

  // Variant pane (card editor) — mutually exclusive with the submodule panel
  variantPaneOpen: boolean;
  variantCardId: string | null;

  // Actions
  openSubmodulePanel: (submoduleId: string, categoryKey: string) => void;
  closeSubmodulePanel: () => void;
  setPanelAccordion: (accordion: PanelAccordion) => void;
  setActiveSubmoduleRunId: (runId: string | null) => void;
  openVariantPane: (cardId: string) => void;
  closeVariantPane: () => void;
  resetPanel: () => void;
}

export const usePanelStore = create<PanelStore>((set) => ({
  submodulePanelOpen: false,
  activeSubmoduleId: null,
  activeCategoryKey: null,
  activeSubmoduleRunId: null,
  panelAccordion: 'input',
  variantPaneOpen: false,
  variantCardId: null,

  openSubmodulePanel: (submoduleId, categoryKey) =>
    set({
      submodulePanelOpen: true,
      activeSubmoduleId: submoduleId,
      activeCategoryKey: categoryKey,
      activeSubmoduleRunId: null, // Reset so effect can set from latestRuns
      panelAccordion: 'input',
      variantPaneOpen: false, // the two left-slide panes are mutually exclusive
    }),

  closeSubmodulePanel: () =>
    set({
      submodulePanelOpen: false,
    }),

  setPanelAccordion: (accordion) =>
    set({ panelAccordion: accordion }),

  setActiveSubmoduleRunId: (runId) =>
    set({ activeSubmoduleRunId: runId }),

  openVariantPane: (cardId) =>
    set({ variantPaneOpen: true, variantCardId: cardId, submodulePanelOpen: false }),

  closeVariantPane: () =>
    set({ variantPaneOpen: false }),

  resetPanel: () =>
    set({
      submodulePanelOpen: false,
      activeSubmoduleId: null,
      activeCategoryKey: null,
      activeSubmoduleRunId: null,
      panelAccordion: 'input',
      variantPaneOpen: false,
      variantCardId: null,
    }),
}));
