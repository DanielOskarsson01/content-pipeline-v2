interface StepApprovalFooterProps {
  status: 'active' | 'completed' | 'skipped';
  canApprove: boolean;
  onApprove: () => void;
  onSkip: () => void;
  onReopen?: () => void;
  isApproving?: boolean;
  isSkipping?: boolean;
  isReopening?: boolean;
}

export function StepApprovalFooter({
  status,
  canApprove,
  onApprove,
  onSkip,
  onReopen,
  isApproving = false,
  isSkipping = false,
  isReopening = false,
}: StepApprovalFooterProps) {
  if (status === 'completed') {
    return (
      <div className="mt-4 flex justify-end items-center gap-3">
        <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-green-100 text-green-700 text-xs font-medium">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          Step Completed
        </span>
        {onReopen && (
          <button
            onClick={onReopen}
            disabled={isReopening}
            className={`px-4 py-1.5 rounded text-xs font-medium ${
              isReopening ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : 'bg-gray-100 hover:bg-gray-200 text-gray-600'
            }`}
          >
            {isReopening ? 'Reopening...' : 'Reopen Step'}
          </button>
        )}
      </div>
    );
  }

  if (status === 'skipped') {
    return (
      <div className="mt-4 flex justify-end">
        <span className="text-xs text-gray-400 italic">Step was skipped</span>
      </div>
    );
  }

  const isBusy = isApproving || isSkipping;

  return (
    <div className="mt-4 flex justify-end gap-2">
      <button
        onClick={onSkip}
        disabled={isBusy}
        className={`px-4 py-1.5 rounded text-xs font-medium ${
          isBusy ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : 'bg-gray-100 hover:bg-gray-200 text-gray-600'
        }`}
      >
        {isSkipping ? 'Skipping...' : 'Skip Step'}
      </button>
      <button
        onClick={onApprove}
        disabled={!canApprove || isBusy}
        className={`px-4 py-1.5 rounded text-xs font-medium shadow-sm ${
          !canApprove || isBusy
            ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
            : 'bg-[#0891B2] hover:bg-[#0891B2]/90 text-white'
        }`}
      >
        {isApproving ? (
          <span className="inline-flex items-center gap-1">
            <span className="inline-block animate-spin rounded-full h-3 w-3 border-b-2 border-white" />
            Approving...
          </span>
        ) : (
          'Approve Step'
        )}
      </button>
    </div>
  );
}
