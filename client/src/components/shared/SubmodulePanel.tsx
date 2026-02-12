import { useEffect } from 'react';
import { usePanelStore, type PanelAccordion } from '../../stores/panelStore';

type AccordionVariant = 'blue' | 'teal' | 'pink';

const VARIANT_COLORS: Record<AccordionVariant, { bg: string; buttonBg: string; buttonText: string }> = {
  blue: { bg: 'bg-[#3B82F6]', buttonBg: 'bg-white', buttonText: 'text-[#3B82F6]' },
  teal: { bg: 'bg-[#0891B2]', buttonBg: 'bg-[#E11D73]', buttonText: 'text-white' },
  pink: { bg: 'bg-[#E11D73]', buttonBg: 'bg-white', buttonText: 'text-[#E11D73]' },
};

const DATA_OP_OPTIONS = ['add', 'remove', 'transform'] as const;
const DATA_OP_ICONS: Record<string, string> = { add: '\u2795', remove: '\u2796', transform: '\uFF1D' };
const DATA_OP_LABELS: Record<string, string> = { add: 'Add to pool', remove: 'Filter pool', transform: 'Transform pool' };

interface SubmodulePanelProps {
  stepName: string;
  submoduleName: string;
  submoduleDescription: string;
  dataOperation: 'add' | 'remove' | 'transform';
  onDataOperationChange: (op: 'add' | 'remove' | 'transform') => void;
}

function PanelAccordionItem({
  title,
  isOpen,
  onToggle,
  variant,
  children,
}: {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  variant: AccordionVariant;
  children: React.ReactNode;
}) {
  const colors = VARIANT_COLORS[variant];

  return (
    <div
      className={`bg-white rounded-lg border border-gray-200 ${isOpen ? 'flex-1 flex flex-col min-h-0' : 'flex-shrink-0'}`}
    >
      <button
        onClick={onToggle}
        className={`w-full flex items-center justify-between px-4 py-3 ${colors.bg} text-white rounded-t-lg`}
      >
        <span className="font-semibold text-sm">{title}</span>
        <div
          className={`w-6 h-6 rounded-full ${colors.buttonBg} flex items-center justify-center`}
        >
          <span className={`${colors.buttonText} font-bold text-sm`}>
            {isOpen ? '\u2212' : '+'}
          </span>
        </div>
      </button>
      {isOpen && (
        <div className="p-4 flex-1 overflow-y-auto">{children}</div>
      )}
    </div>
  );
}

export function SubmodulePanel({
  stepName,
  submoduleName,
  submoduleDescription,
  dataOperation,
  onDataOperationChange,
}: SubmodulePanelProps) {
  const {
    submodulePanelOpen,
    panelAccordion,
    closeSubmodulePanel,
    setPanelAccordion,
  } = usePanelStore();

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && submodulePanelOpen) {
        closeSubmodulePanel();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [submodulePanelOpen, closeSubmodulePanel]);

  if (!submodulePanelOpen) return null;

  const cycleDataOp = () => {
    const idx = DATA_OP_OPTIONS.indexOf(dataOperation);
    const next = DATA_OP_OPTIONS[(idx + 1) % DATA_OP_OPTIONS.length];
    onDataOperationChange(next);
  };

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 transition-opacity duration-300 opacity-100"
        onClick={closeSubmodulePanel}
      />

      {/* Panel — slides from left */}
      <div className="fixed inset-y-0 left-0 w-[672px] min-w-[672px] max-w-[672px] bg-gray-100 shadow-2xl flex flex-col transition-transform duration-300 translate-x-0">
        {/* Header */}
        <div className="bg-[#0891B2] text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="text-base font-semibold">
              {stepName} — {submoduleName}
            </h3>
          </div>
          <button
            onClick={closeSubmodulePanel}
            className="p-1 text-white/80 hover:text-white rounded hover:bg-white/10"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Description */}
        <p className="px-4 py-2 text-xs text-gray-500 bg-white border-b flex-shrink-0">
          {submoduleDescription}
        </p>

        {/* Data Operation Toggle */}
        <div className="px-4 py-2 bg-white border-b flex-shrink-0">
          <button
            onClick={cycleDataOp}
            className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900"
            title="Click to cycle data operation"
          >
            <span className="text-lg">{DATA_OP_ICONS[dataOperation]}</span>
            <span className="font-medium">{DATA_OP_LABELS[dataOperation]}</span>
            <span className="text-[10px] text-gray-400 ml-1">(click to change)</span>
          </button>
        </div>

        {/* Accordions */}
        <div className="flex-1 flex flex-col overflow-hidden p-3 gap-3">
          <PanelAccordionItem
            title="Input"
            isOpen={panelAccordion === 'input'}
            onToggle={() => setPanelAccordion(panelAccordion === 'input' ? null : 'input')}
            variant="blue"
          >
            <p className="text-sm text-gray-400">Input content will appear here</p>
          </PanelAccordionItem>

          <PanelAccordionItem
            title="Options"
            isOpen={panelAccordion === 'options'}
            onToggle={() => setPanelAccordion(panelAccordion === 'options' ? null : 'options')}
            variant="teal"
          >
            <p className="text-sm text-gray-400">Options will appear here</p>
          </PanelAccordionItem>

          <PanelAccordionItem
            title="Results"
            isOpen={panelAccordion === 'results'}
            onToggle={() => setPanelAccordion(panelAccordion === 'results' ? null : 'results')}
            variant="pink"
          >
            <p className="text-sm text-gray-400">No results yet. Configure input and click RUN TASK.</p>
          </PanelAccordionItem>
        </div>

        {/* CTA Footer */}
        <div className="border-t border-gray-200 px-4 py-3 bg-white flex-shrink-0">
          <div className="flex items-center justify-center gap-3">
            <button
              disabled
              className="px-8 py-3 rounded text-sm font-medium bg-gray-100 text-gray-400 cursor-not-allowed"
            >
              RUN TASK
            </button>
            <button
              disabled
              className="px-8 py-3 rounded text-sm font-medium bg-gray-100 text-gray-400 cursor-not-allowed"
            >
              SEE RESULTS
            </button>
            <button
              disabled
              className="px-8 py-3 rounded text-sm font-medium bg-gray-100 text-gray-400 cursor-not-allowed"
            >
              APPROVE
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
