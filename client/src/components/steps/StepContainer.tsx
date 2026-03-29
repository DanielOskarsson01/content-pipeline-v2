import type { ReactNode } from 'react';
import { usePipelineStore } from '../../stores/pipelineStore';

export type StepStatus = 'pending' | 'active' | 'completed' | 'skipped' | 'approved';

interface StepContainerProps {
  step: number;
  title: string;
  description: string;
  status: StepStatus;
  children?: ReactNode;
}

function getStepNumberClass(status: StepStatus): string {
  switch (status) {
    case 'active':
      return 'bg-sky-600 text-white';
    case 'completed':
    case 'approved':
      return 'bg-green-500 text-white';
    case 'skipped':
      return 'bg-gray-300 text-gray-500';
    default:
      return 'bg-gray-200 text-gray-500';
  }
}

function getStatusBadgeClass(status: StepStatus): string {
  switch (status) {
    case 'active':
      return 'bg-sky-100 text-sky-700';
    case 'completed':
    case 'approved':
      return 'bg-green-100 text-green-700';
    case 'skipped':
      return 'bg-gray-100 text-gray-500';
    default:
      return 'bg-gray-100 text-gray-500';
  }
}

function getContainerClass(status: StepStatus): string {
  const base = 'rounded-lg border overflow-hidden transition-all';
  if (status === 'active') return `${base} bg-white border-sky-500 shadow-md ring-1 ring-sky-200`;
  if (status === 'completed' || status === 'approved') return `${base} bg-white border-gray-200`;
  if (status === 'skipped') return `${base} bg-gray-50 border-gray-200 opacity-40`;
  return `${base} bg-gray-50 border-gray-200 opacity-60`;
}

export function StepContainer({ step, title, description, status, children }: StepContainerProps) {
  const { expandedStep, toggleStep } = usePipelineStore();
  const isExpanded = expandedStep === step;
  const isClickable = status === 'active' || status === 'completed' || status === 'approved';

  return (
    <div className={getContainerClass(status)}>
      <div
        className={`flex items-center gap-3 px-4 py-3 select-none ${isClickable ? 'cursor-pointer' : 'cursor-default'}`}
        onClick={() => isClickable && toggleStep(step)}
      >
        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${getStepNumberClass(status)}`}>
          {(status === 'completed' || status === 'approved') ? <span className="text-sm">✓</span> : <span>{step}</span>}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${status === 'active' ? 'text-gray-900' : status === 'completed' ? 'text-gray-700' : 'text-gray-400'}`}>
              {title}
            </span>
            {status === 'skipped' && <span className="text-xs text-gray-400 italic">skipped</span>}
          </div>
          <p className={`text-xs truncate ${status === 'active' ? 'text-gray-500' : 'text-gray-300'}`}>
            {description}
          </p>
        </div>

        <div className={`flex items-center gap-2 flex-shrink-0 ${isClickable ? '' : 'opacity-50'}`}>
          <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusBadgeClass(status)}`}>
            {status}
          </span>
          {isClickable && (
            <span className="text-gray-400 text-sm">{isExpanded ? '▲' : '▼'}</span>
          )}
        </div>
      </div>

      {isExpanded && children && (
        <div className="border-t border-gray-200">
          <div className="p-4">{children}</div>
        </div>
      )}
    </div>
  );
}
