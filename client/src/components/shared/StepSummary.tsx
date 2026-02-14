interface SubmoduleSummaryRow {
  name: string;
  dataOperation: 'add' | 'remove' | 'transform';
  resultCount: number;
  status: string;
  description?: string;
}

interface StepSummaryProps {
  submodules: SubmoduleSummaryRow[];
}

const OP_ICON: Record<string, string> = { add: '➕', remove: '➖', transform: '＝' };

export function StepSummary({ submodules }: StepSummaryProps) {
  const approved = submodules.filter((s) => s.status === 'approved');

  if (approved.length === 0) {
    return (
      <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
        <p className="text-xs text-gray-400">No approved submodules yet</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
      <p className="text-xs text-gray-600 font-medium uppercase mb-2">Summary</p>
      <div className="space-y-1">
        {approved.map((s) => (
          <div key={s.name} className="flex items-center gap-2 text-sm text-gray-700">
            <span>{OP_ICON[s.dataOperation] || '＝'}</span>
            <span>{s.name}:</span>
            <span className="font-medium">
              {s.description || `${s.resultCount} items approved`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
