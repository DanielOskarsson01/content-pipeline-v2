import type { PipelineStage, Project } from '../../types/step';
import { StepApprovalFooter } from '../shared/StepApprovalFooter';

interface Step0ViewProps {
  stage: PipelineStage;
  project: Project;
  onApprove: () => void;
  onSkip: () => void;
  isApproving: boolean;
  isSkipping: boolean;
}

export function Step0View({ stage, project, onApprove, onSkip, isApproving, isSkipping }: Step0ViewProps) {
  return (
    <div>
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <h3 className="text-sm font-medium text-gray-900 mb-3">Project Summary</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-gray-500">Name</dt>
          <dd className="text-gray-900 font-medium">{project.name}</dd>

          {project.description && (
            <>
              <dt className="text-gray-500">Intent</dt>
              <dd className="text-gray-900">{project.description}</dd>
            </>
          )}

          <dt className="text-gray-500">Status</dt>
          <dd className="text-gray-900">{project.status}</dd>

          <dt className="text-gray-500">Created</dt>
          <dd className="text-gray-900">{new Date(project.created_at).toLocaleString()}</dd>
        </dl>
      </div>

      <StepApprovalFooter
        status={stage.status as 'active' | 'completed' | 'skipped'}
        canApprove={stage.status === 'active'}
        onApprove={onApprove}
        onSkip={onSkip}
        isApproving={isApproving}
        isSkipping={isSkipping}
      />
    </div>
  );
}
