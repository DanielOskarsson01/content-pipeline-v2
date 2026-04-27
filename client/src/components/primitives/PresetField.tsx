import { useState } from 'react';
import { usePresets, useCreatePreset, useDeletePreset, useSetDefaultPreset } from '../../hooks/usePresets';
import type { OptionPreset } from '../../types/step';

interface PresetFieldProps {
  submoduleId: string;
  optionName: string;
  projectId: string;
  currentValue: unknown;
  onLoadPreset: (value: unknown) => void;
}

/**
 * Preset dropdown + save button for a submodule option.
 * Appears above options marked with presets_enabled: true.
 */
export function PresetField({
  submoduleId,
  optionName,
  projectId,
  currentValue,
  onLoadPreset,
}: PresetFieldProps) {
  const { data: presets, isLoading } = usePresets(submoduleId, optionName, projectId);
  const createPreset = useCreatePreset();
  const deletePreset = useDeletePreset(submoduleId, optionName);
  const setDefault = useSetDefaultPreset(submoduleId, optionName);

  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [saveGlobal, setSaveGlobal] = useState(false);

  const activePreset = presets?.find(
    (p) => JSON.stringify(p.preset_value) === JSON.stringify(currentValue)
  );

  const handleLoadPreset = (preset: OptionPreset) => {
    onLoadPreset(preset.preset_value);
  };

  const handleSave = () => {
    if (!newPresetName.trim()) return;
    createPreset.mutate(
      {
        submodule_id: submoduleId,
        option_name: optionName,
        preset_name: newPresetName.trim(),
        preset_value: currentValue,
        ...(saveGlobal ? {} : { project_id: projectId }),
      },
      {
        onSuccess: () => {
          setNewPresetName('');
          setShowSaveDialog(false);
        },
      }
    );
  };

  if (isLoading) return null;

  return (
    <div className="flex items-center gap-2 mb-1">
      {/* Preset dropdown — always shows all saved presets */}
      <select
        value={activePreset?.id || ''}
        onChange={(e) => {
          const preset = presets?.find((p) => p.id === e.target.value);
          if (preset) handleLoadPreset(preset);
        }}
        className="flex-1 bg-white border border-gray-300 rounded px-2 py-1 text-xs text-gray-700 focus:outline-none focus:border-[#0891B2]"
      >
        <option value="">— Presets —</option>
        {presets?.map((p) => (
          <option key={p.id} value={p.id}>
            {p.preset_name}
            {p.is_default ? ' ★' : ''}
            {p.project_id ? '' : ' (global)'}
          </option>
        ))}
      </select>

      {/* Always show save button */}
      <button
        onClick={() => setShowSaveDialog(true)}
        className="text-[10px] text-[#0891B2] hover:underline whitespace-nowrap"
      >
        {activePreset ? '+' : 'Save as preset'}
      </button>

      {/* Star / delete only when a preset is selected */}
      {activePreset && (
        <div className="flex gap-1">
          {!activePreset.is_default && (
            <button
              onClick={() => setDefault.mutate(activePreset.id)}
              className="text-[10px] text-gray-400 hover:text-[#0891B2]"
              title="Set as default"
            >
              ★
            </button>
          )}
          <button
            onClick={() => {
              if (confirm(`Delete preset "${activePreset.preset_name}"?`)) {
                deletePreset.mutate(activePreset.id);
              }
            }}
            className="text-[10px] text-gray-400 hover:text-red-500"
            title="Delete preset"
          >
            ✕
          </button>
        </div>
      )}

      {/* Save dialog */}
      {showSaveDialog && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowSaveDialog(false)}>
          <div className="bg-white rounded-lg shadow-xl p-4 w-80" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-gray-900 mb-3">Save Preset</h3>
            <input
              type="text"
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              placeholder="Preset name..."
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm mb-2 focus:outline-none focus:border-[#0891B2]"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            />
            <label className="flex items-center gap-2 text-xs text-gray-600 mb-3">
              <input
                type="checkbox"
                checked={saveGlobal}
                onChange={(e) => setSaveGlobal(e.target.checked)}
                className="rounded border-gray-300 text-[#0891B2]"
              />
              Global preset (available in all projects)
            </label>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSaveDialog(false)}
                className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!newPresetName.trim() || createPreset.isPending}
                className="px-3 py-1.5 text-xs bg-[#0891B2] text-white rounded hover:bg-[#0891B2]/90 disabled:opacity-50"
              >
                {createPreset.isPending ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
