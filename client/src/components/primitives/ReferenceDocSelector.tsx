import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';

const API_BASE = import.meta.env.VITE_API_URL || '';

interface ReferenceDoc {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}

interface ReferenceDocSelectorProps {
  projectId: string;
  value: string[];
  onChange: (docIds: string[]) => void;
}

export function ReferenceDocSelector({ projectId, value, onChange }: ReferenceDocSelectorProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data: docs = [], isLoading } = useQuery<ReferenceDoc[]>({
    queryKey: ['reference-docs', projectId],
    queryFn: () => apiFetch<ReferenceDoc[]>(`/api/projects/${projectId}/reference-docs`),
    enabled: !!projectId,
  });

  const deleteMutation = useMutation({
    mutationFn: (docId: string) =>
      apiFetch(`/api/projects/${projectId}/reference-docs/${docId}`, { method: 'DELETE' }),
    onSuccess: (_data, docId) => {
      queryClient.invalidateQueries({ queryKey: ['reference-docs', projectId] });
      // Remove deleted doc from selection
      if (value.includes(docId)) {
        onChange(value.filter((id) => id !== docId));
      }
    },
  });

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);

    const formData = new FormData();
    for (const file of Array.from(files)) {
      formData.append('files', file);
    }

    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/reference-docs`, {
        method: 'POST',
        body: formData,
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Upload failed');
      }
      queryClient.invalidateQueries({ queryKey: ['reference-docs', projectId] });
      // Auto-select newly uploaded docs
      if (result.uploaded?.length > 0) {
        const newIds = result.uploaded.map((d: ReferenceDoc) => d.id);
        const merged = [...new Set([...value, ...newIds])];
        onChange(merged);
      }
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const toggleDoc = (docId: string) => {
    if (value.includes(docId)) {
      onChange(value.filter((id) => id !== docId));
    } else {
      onChange([...value, docId]);
    }
  };

  const handleDelete = (docId: string, filename: string) => {
    if (confirm(`Delete "${filename}"? This cannot be undone.`)) {
      deleteMutation.mutate(docId);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-2">
      {/* Upload area */}
      <div
        className="border border-dashed border-gray-300 rounded px-3 py-2 text-center cursor-pointer hover:border-[#0891B2] transition-colors"
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.txt,.csv,.json"
          multiple
          className="hidden"
          onChange={(e) => handleUpload(e.target.files)}
        />
        <p className="text-xs text-gray-500">
          {uploading ? 'Uploading...' : 'Click to upload reference docs (.md, .txt, .csv, .json)'}
        </p>
      </div>

      {/* Doc list */}
      {isLoading && <p className="text-xs text-gray-400">Loading docs...</p>}

      {docs.length > 0 && (
        <div className="space-y-1">
          {docs.map((doc) => (
            <div key={doc.id} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={value.includes(doc.id)}
                onChange={() => toggleDoc(doc.id)}
                className="w-3.5 h-3.5 rounded border-gray-300 text-[#0891B2] focus:ring-[#0891B2] cursor-pointer"
              />
              <span className="text-gray-700 flex-1 truncate" title={doc.filename}>
                {doc.filename}
              </span>
              <span className="text-gray-400 flex-shrink-0">{formatSize(doc.size_bytes)}</span>
              <button
                onClick={() => handleDelete(doc.id, doc.filename)}
                className="text-gray-400 hover:text-red-500 flex-shrink-0"
                title="Delete document"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {!isLoading && docs.length === 0 && (
        <p className="text-[10px] text-gray-400 text-center">
          No reference docs uploaded yet
        </p>
      )}
    </div>
  );
}
