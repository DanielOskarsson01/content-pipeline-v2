import { useAppStore } from '../../stores/appStore';

export function Toast() {
  const { toast, hideToast } = useAppStore();

  if (!toast) return null;

  const bgColor = {
    success: 'bg-green-500',
    error: 'bg-red-500',
    info: 'bg-blue-500',
  }[toast.type];

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div
        className={`${bgColor} text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3`}
      >
        <span>{toast.message}</span>
        <button
          onClick={hideToast}
          className="text-white/80 hover:text-white"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
