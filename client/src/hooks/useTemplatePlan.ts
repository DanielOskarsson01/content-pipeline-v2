import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { TemplateExecutionPlan } from '../types/step';

/**
 * The template detail (incl. execution_plan) that the variant rows + pane read.
 * Uses the SAME `['template', id]` cache key TemplateEditor uses, so card edits made here and in
 * the template editor share one cache entry.
 */
export function useTemplatePlan(templateId: string | null | undefined) {
  return useQuery({
    queryKey: ['template', templateId],
    queryFn: () => api.getTemplate(templateId!),
    enabled: !!templateId,
  });
}

/**
 * The ONE card/variant write path: a single `api.updateTemplate(templateId, { execution_plan })`
 * PUT (the second call site of TemplateEditor's update mutation). Invalidates `['template', id]` +
 * `['templates']`. It NEVER touches the run-scoped `saveSubmoduleConfig` endpoint — a card write and
 * a run-config save are two scopes that never mix. `mutation.error` carries the server's §9
 * `details[]` (see ApiError in api/client) for inline surfacing.
 */
export function useTemplateCardMutation(templateId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (execution_plan: TemplateExecutionPlan) => {
      if (!templateId) throw new Error('No template — save the project as a template first');
      return api.updateTemplate(templateId, { execution_plan });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['template', templateId] });
      queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
  });
}
