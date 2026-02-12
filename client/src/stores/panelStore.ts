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

  // Accordion state
  panelAccordion: PanelAccordion;

  // Actions
  openSubmodulePanel: (submoduleId: string, categoryKey: string) => void;
  closeSubmodulePanel: () => void;
  setPanelAccordion: (accordion: PanelAccordion) => void;
}

export const usePanelStore = create<PanelStore>((set) => ({
  submodulePanelOpen: false,
  activeSubmoduleId: null,
  activeCategoryKey: null,
  panelAccordion: 'input',

  openSubmodulePanel: (submoduleId, categoryKey) =>
    set({
      submodulePanelOpen: true,
      activeSubmoduleId: submoduleId,
      activeCategoryKey: categoryKey,
      panelAccordion: 'input',
    }),

  closeSubmodulePanel: () =>
    set({
      submodulePanelOpen: false,
    }),

  setPanelAccordion: (accordion) =>
    set({ panelAccordion: accordion }),
}));
