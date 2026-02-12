import { create } from 'zustand';

interface Toast {
  message: string;
  type: 'success' | 'error' | 'info';
}

interface AppStore {
  toast: Toast | null;
  showToast: (message: string, type?: Toast['type']) => void;
  hideToast: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  toast: null,
  showToast: (message, type = 'info') => {
    set({ toast: { message, type } });
    setTimeout(() => set({ toast: null }), 3000);
  },
  hideToast: () => set({ toast: null }),
}));
