import { create } from 'zustand';

interface PipelineStore {
  expandedStep: number | null;
  toggleStep: (step: number) => void;
  setExpandedStep: (step: number | null) => void;
}

export const usePipelineStore = create<PipelineStore>((set, get) => ({
  expandedStep: null,
  toggleStep: (step) => {
    set({ expandedStep: get().expandedStep === step ? null : step });
  },
  setExpandedStep: (step) => set({ expandedStep: step }),
}));
