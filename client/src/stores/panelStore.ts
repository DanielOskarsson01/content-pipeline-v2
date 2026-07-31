import { create } from 'zustand';

export type PanelAccordion = 'input' | 'options' | 'results' | 'tryit' | null;

/**
 * Last workbench experiment run this session (either surface) — a POINTER
 * (ids + status only, no result payload; the payload stays in TanStack/local
 * state). Held here so the chaining affordance survives switching
 * step/submodule in the panel.
 */
export interface LastExperimentRef {
  id: string;
  source_run_id: string;
  submodule_id: string;
  entity_name: string;
  status: string;
}

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

  // Last workbench experiment (chaining affordance — U8 UI half)
  lastExperiment: LastExperimentRef | null;

  // Variant pane (card editor) — mutually exclusive with the submodule panel
  variantPaneOpen: boolean;
  variantCardId: string | null;

  // Clone dialog (S2.3) — name/describe/round-select before creating a card. Carries the submodule +
  // step it clones and the round tab it was opened from (the preselected round).
  cloneDialogOpen: boolean;
  cloneSubmoduleId: string | null;
  cloneStep: number | null;
  cloneRound: number;

  // Actions
  openSubmodulePanel: (submoduleId: string, categoryKey: string) => void;
  closeSubmodulePanel: () => void;
  setPanelAccordion: (accordion: PanelAccordion) => void;
  setActiveSubmoduleRunId: (runId: string | null) => void;
  setLastExperiment: (exp: LastExperimentRef | null) => void;
  openVariantPane: (cardId: string) => void;
  closeVariantPane: () => void;
  openCloneDialog: (submoduleId: string, step: number, round: number) => void;
  closeCloneDialog: () => void;
  resetPanel: () => void;
}

export const usePanelStore = create<PanelStore>((set) => ({
  submodulePanelOpen: false,
  activeSubmoduleId: null,
  activeCategoryKey: null,
  activeSubmoduleRunId: null,
  panelAccordion: 'input',
  lastExperiment: null,
  variantPaneOpen: false,
  variantCardId: null,
  cloneDialogOpen: false,
  cloneSubmoduleId: null,
  cloneStep: null,
  cloneRound: 1,

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

  setLastExperiment: (exp) =>
    set({ lastExperiment: exp }),

  openVariantPane: (cardId) =>
    set({ variantPaneOpen: true, variantCardId: cardId, submodulePanelOpen: false, cloneDialogOpen: false }),

  closeVariantPane: () =>
    set({ variantPaneOpen: false }),

  openCloneDialog: (submoduleId, step, round) =>
    set({ cloneDialogOpen: true, cloneSubmoduleId: submoduleId, cloneStep: step, cloneRound: round }),

  closeCloneDialog: () =>
    set({ cloneDialogOpen: false }),

  resetPanel: () =>
    set({
      submodulePanelOpen: false,
      activeSubmoduleId: null,
      activeCategoryKey: null,
      activeSubmoduleRunId: null,
      panelAccordion: 'input',
      variantPaneOpen: false,
      variantCardId: null,
      cloneDialogOpen: false,
      cloneSubmoduleId: null,
      cloneStep: null,
    }),
}));
