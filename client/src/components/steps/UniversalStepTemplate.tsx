import { useMemo, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PipelineStage, SubmoduleManifest } from '../../types/step';
import { useStepSubmodules } from '../../hooks/useSubmodules';
import { useSubmoduleConfig, useSubmoduleConfigs, useSaveSubmoduleConfig } from '../../hooks/useSubmoduleConfig';
import { useLatestSubmoduleRuns } from '../../hooks/useSubmoduleRuns';
import { usePanelStore } from '../../stores/panelStore';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../api/client';
import { CategoryCardGrid } from '../shared/CategoryCardGrid';
import { SubmodulePanel } from '../shared/SubmodulePanel';
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
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);
  const isCompleted = stage.status === 'completed';
  const { data: categories, isLoading: submodulesLoading } = useStepSubmodules(stage.step_index);
  const { activeSubmoduleId } = usePanelStore();
  const { data: latestRuns } = useLatestSubmoduleRuns(stage.run_id, stage.step_index);

  // All submodule configs for this step — used by CategoryCardGrid for data op display
  const { data: configMap } = useSubmoduleConfigs(stage.run_id, stage.step_index);

  // Flatten categories to find active submodule by ID
  const activeSubmodule: SubmoduleManifest | null = useMemo(() => {
    if (!activeSubmoduleId || !categories) return null;
    for (const subs of Object.values(categories)) {
      const found = subs.find((s) => s.id === activeSubmoduleId);
      if (found) return found;
    }
    return null;
  }, [activeSubmoduleId, categories]);

  // Submodule config — persisted via API (for active submodule panel)
  const { data: savedConfig } = useSubmoduleConfig(stage.run_id, stage.step_index, activeSubmoduleId);
  const saveConfig = useSaveSubmoduleConfig(stage.run_id, stage.step_index, activeSubmoduleId);

  const currentDataOp = savedConfig?.data_operation
    || activeSubmodule?.data_operation_default
    || 'add';

  const handleDataOpChange = (op: 'add' | 'remove' | 'transform') => {
    saveConfig.mutate({ data_operation: op }, {
      onSuccess: () => {
        // Also invalidate the batch configs query so CategoryCardGrid updates
        queryClient.invalidateQueries({ queryKey: ['submoduleConfigs', stage.run_id, stage.step_index] });
      },
    });
  };

  const handleSaveConfig = (config: Partial<typeof savedConfig>) => {
    saveConfig.mutate(config, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['submoduleConfigs', stage.run_id, stage.step_index] });
      },
    });
  };

  // CategoryCardGrid data op toggle — saves for any submodule (not just the active one)
  const handleGridDataOpChange = useCallback(async (submoduleId: string, op: 'add' | 'remove' | 'transform') => {
    try {
      await api.saveSubmoduleConfig(stage.run_id, stage.step_index, submoduleId, { data_operation: op });
      queryClient.invalidateQueries({ queryKey: ['submoduleConfigs', stage.run_id, stage.step_index] });
      // Also invalidate the per-submodule config in case the panel is open for this submodule
      queryClient.invalidateQueries({ queryKey: ['submoduleConfig', stage.run_id, stage.step_index, submoduleId] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save data operation', 'error');
    }
  }, [stage.run_id, stage.step_index, queryClient, showToast]);

  return (
    <div>
      {/* CategoryCardGrid — real manifest data */}
      {submodulesLoading ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center mb-4">
          <p className="text-gray-400 text-sm">Loading submodules...</p>
        </div>
      ) : (
        <CategoryCardGrid
          categories={categories || {}}
          latestRuns={latestRuns}
          configMap={configMap}
          onDataOperationChange={handleGridDataOpChange}
        />
      )}

      {/* StepSummary — empty for now (populated when submodules have runs) */}
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

      {/* Approval footer */}
      {(stage.status === 'active' || isCompleted || stage.status === 'skipped') && (
        <StepApprovalFooter
          status={stage.status as 'active' | 'completed' | 'skipped'}
          canApprove={false}
          onApprove={onApprove}
          onSkip={onSkip}
          isApproving={isApproving}
          isSkipping={isSkipping}
        />
      )}

      {/* SubmodulePanel — slides from left when submodule row clicked */}
      <SubmodulePanel
        stepName={stage.step_name}
        submodule={activeSubmodule}
        runId={stage.run_id}
        stepIndex={stage.step_index}
        dataOperation={currentDataOp}
        onDataOperationChange={handleDataOpChange}
        savedConfig={savedConfig}
        onSaveConfig={handleSaveConfig}
      />
    </div>
  );
}
