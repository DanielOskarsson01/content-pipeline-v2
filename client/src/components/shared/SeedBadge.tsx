const COLORS: Record<string, string> = {
  csv: 'bg-emerald-100 text-emerald-700',
  url: 'bg-blue-100 text-blue-700',
  prompt: 'bg-purple-100 text-purple-700',
};

export function SeedBadge({ seedType }: { seedType: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium uppercase ${COLORS[seedType] || 'bg-gray-100 text-gray-600'}`}>
      {seedType}
    </span>
  );
}
