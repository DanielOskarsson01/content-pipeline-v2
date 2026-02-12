import type { PipelineStage } from '../../types/step';
import { StepSummary } from '../shared/StepSummary';
import { StepApprovalFooter } from '../shared/StepApprovalFooter';

interface UniversalStepTemplateProps {
  stage: PipelineStage;
  onApprove: () => void;
  onSkip: () => void;
  isApproving: boolean;
  isSkipping: boolean;
}

export function UniversalStepTemplate({ stage, onApprove, onSkip, isApproving, isSkipping }: UniversalStepTemplateProps) {
  const isActive = stage.status === 'active';
  const isCompleted = stage.status === 'completed';

  return (
    <div>
      {/* CategoryCardGrid area — Phase 4 will populate this */}
      <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center mb-4">
        <p className="text-gray-400 text-sm">No submodules available</p>
        <p className="text-gray-300 text-xs mt-1">Submodules will appear here once modules are discovered (Phase 4)</p>
      </div>

      {/* StepSummary — empty for now */}
      <div className="mb-4">
        <StepSummary submodules={[]} />
      </div>

      {/* Completed step read-only output */}
      {isCompleted && stage.output_data && (
        <div className="bg-gray-50 rounded-lg border border-gray-200 p-4 mb-4">
          <p className="text-xs text-gray-500 font-medium uppercase mb-2">Step Output</p>
          <pre className="text-xs text-gray-600 overflow-auto max-h-48">
            {JSON.stringify(stage.output_data, null, 2)}
          </pre>
        </div>
      )}

      {/* Approval footer — only for active steps */}
      {(isActive || isCompleted || stage.status === 'skipped') && (
        <StepApprovalFooter
          status={stage.status as 'active' | 'completed' | 'skipped'}
          canApprove={false}
          onApprove={onApprove}
          onSkip={onSkip}
          isApproving={isApproving}
          isSkipping={isSkipping}
        />
      )}
    </div>
  );
}
