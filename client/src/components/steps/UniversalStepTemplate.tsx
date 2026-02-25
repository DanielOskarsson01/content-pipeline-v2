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
import { ContentRenderer, type RenderSchema } from '../primitives/ContentRenderer';

interface UniversalStepTemplateProps {
  stage: PipelineStage;
  projectId: string;
  onApprove: () => void;
  onSkip: () => void;
  onReopen?: () => void;
  isApproving: boolean;
  isSkipping: boolean;
  isReopening?: boolean;
}

export function UniversalStepTemplate({ stage, projectId, onApprove, onSkip, onReopen, isApproving, isSkipping, isReopening }: UniversalStepTemplateProps) {
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);
  const isCompleted = stage.status === 'completed';
  const { data: categories, isLoading: submodulesLoading } = useStepSubmodules(stage.step_index);
  const { activeSubmoduleId } = usePanelStore();
  const { data: latestRuns } = useLatestSubmoduleRuns(stage.run_id, stage.step_index);

  // All submodule configs for this step — used by CategoryCardGrid for data op display
  const { data: configMap } = useSubmoduleConfigs(stage.run_id, stage.step_index);

  // canApprove: true when at least one submodule has an approved run
  const hasApprovedSubmodule = useMemo(() => {
    if (!latestRuns) return false;
    return Object.values(latestRuns).some((run) => run.status === 'approved');
  }, [latestRuns]);

  // Build summary rows for StepSummary from latestRuns + categories + configMap
  const summaryRows = useMemo(() => {
    if (!latestRuns || !categories || !configMap) return [];
    const rows: Array<{ name: string; dataOperation: 'add' | 'remove' | 'transform'; resultCount: number; status: string; description?: string }> = [];
    for (const subs of Object.values(categories)) {
      for (const sub of subs) {
        const run = latestRuns[sub.id];
        if (run) {
          const savedOp = configMap[sub.id]?.data_operation;
          rows.push({
            name: sub.name,
            dataOperation: (savedOp || sub.data_operation_default) as 'add' | 'remove' | 'transform',
            resultCount: run.approved_count || run.result_count || 0,
            status: run.status,
            description: run.description,
          });
        }
      }
    }
    return rows;
  }, [latestRuns, categories, configMap]);

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
        queryClient.invalidateQueries({ queryKey: ['submoduleConfigs', stage.run_id, stage.step_index] });
      },
    });
  };

  const handleSaveConfig = async (config: Partial<NonNullable<typeof savedConfig>>) => {
    await saveConfig.mutateAsync(config);
    queryClient.invalidateQueries({ queryKey: ['submoduleConfigs', stage.run_id, stage.step_index] });
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

      {/* StepSummary */}
      <div className="mb-4">
        <StepSummary submodules={summaryRows} />
      </div>

      {/* Completed step read-only output */}
      {isCompleted && stage.output_data && (
        <div className="bg-gray-50 rounded-lg border border-gray-200 p-4 mb-4">
          <p className="text-xs text-gray-500 font-medium uppercase mb-2">Step Output</p>
          {Array.isArray(stage.output_data) && stage.output_data.length > 0 ? (
            <ContentRenderer
              entities={stage.output_data as Record<string, unknown>[]}
              renderSchema={stage.output_render_schema as RenderSchema | undefined}
              maxHeight={320}
              label={`${(stage.output_data as unknown[]).length} items`}
            />
          ) : (
            <pre className="text-xs text-gray-600 overflow-auto max-h-48">
              {JSON.stringify(stage.output_data, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* Approval footer */}
      {(stage.status === 'active' || isCompleted || stage.status === 'skipped') && (
        <StepApprovalFooter
          status={stage.status as 'active' | 'completed' | 'skipped'}
          canApprove={hasApprovedSubmodule}
          onApprove={onApprove}
          onSkip={onSkip}
          onReopen={onReopen}
          isApproving={isApproving}
          isSkipping={isSkipping}
          isReopening={isReopening}
        />
      )}

      {/* SubmodulePanel — slides from left when submodule row clicked */}
      <SubmodulePanel
        stepName={stage.step_name}
        submodule={activeSubmodule}
        projectId={projectId}
        runId={stage.run_id}
        stepIndex={stage.step_index}
        dataOperation={currentDataOp}
        onDataOperationChange={handleDataOpChange}
        savedConfig={savedConfig}
        onSaveConfig={handleSaveConfig}
        previousStepData={
          (currentDataOp === 'remove' || currentDataOp === 'add') && Array.isArray(stage.working_pool) && (stage.working_pool as unknown[]).length > 0
            ? stage.working_pool as Record<string, unknown>[]
            : stage.input_data as Record<string, unknown>[] | null
        }
        previousStepRenderSchema={stage.input_render_schema as Record<string, unknown> | null}
      />
    </div>
  );
}
