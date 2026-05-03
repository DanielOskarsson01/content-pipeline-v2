import { useState, useCallback, useEffect } from 'react';
import { api } from '../../api/client';

interface UploadedFile {
  filename: string;
  size_bytes: number;
  uploaded_at?: string;
  rows?: number;
  converted?: boolean;
}

interface CsvDiscoveryUploadProps {
  projectId: string;
  accept?: string;
  onChange: (uploadDir: string) => void;
}

/**
 * Drag-and-drop CSV/XLSX upload zone for csv-discovery.
 * Uploads files to the server, which stores them in a per-project directory.
 * After upload, sets the upload_dir option so csv-discovery reads from it.
 */
export function CsvDiscoveryUpload({ projectId, accept = '.csv,.xlsx,.xls', onChange }: CsvDiscoveryUploadProps) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load existing files on mount
  useEffect(() => {
    api.listCsvFiles(projectId).then(({ files: serverFiles, upload_dir }) => {
      setFiles(serverFiles);
      if (serverFiles.length > 0) {
        onChange(upload_dir);
      }
    }).catch(() => {});
  }, [projectId]);

  const handleUpload = useCallback(async (fileList: FileList | File[]) => {
    const arr = Array.from(fileList);
    if (arr.length === 0) return;

    setUploading(true);
    setError(null);

    const formData = new FormData();
    for (const file of arr) {
      formData.append('files', file);
    }

    try {
      const result = await api.uploadCsvFiles(projectId, formData);
      if (result.errors.length > 0) {
        setError(result.errors.join('; '));
      }
      // Refresh file list
      const { files: updated, upload_dir } = await api.listCsvFiles(projectId);
      setFiles(updated);
      onChange(upload_dir);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [projectId, onChange]);

  const handleDelete = useCallback(async (filename: string) => {
    try {
      await api.deleteCsvFile(projectId, filename);
      const { files: updated } = await api.listCsvFiles(projectId);
      setFiles(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }, [projectId]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      handleUpload(e.dataTransfer.files);
    }
  }, [handleUpload]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  return (
    <div className="space-y-2">
      {/* Drop zone */}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={`border-2 border-dashed rounded-lg p-4 text-center transition-colors cursor-pointer ${
          dragOver
            ? 'border-[#0891B2] bg-[#0891B2]/5'
            : 'border-gray-300 hover:border-gray-400'
        }`}
        onClick={() => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = accept;
          input.multiple = true;
          input.onchange = () => {
            if (input.files) handleUpload(input.files);
          };
          input.click();
        }}
      >
        {uploading ? (
          <div className="text-sm text-gray-500">
            <span className="animate-pulse">Uploading...</span>
          </div>
        ) : (
          <div className="text-sm text-gray-500">
            <span className="text-[#0891B2] font-medium">Click to upload</span>
            {' '}or drag and drop
            <div className="text-[10px] text-gray-400 mt-1">
              CSV, XLSX, or XLS files (XLSX auto-converted to CSV)
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <p className="text-[10px] text-red-500">{error}</p>
      )}

      {/* File list */}
      {files.length > 0 && (
        <div className="space-y-1">
          {files.map((f) => (
            <div key={f.filename} className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
              <div className="flex-1 min-w-0">
                <span className="text-xs text-gray-700 truncate block">{f.filename}</span>
                <span className="text-[10px] text-gray-400">
                  {formatBytes(f.size_bytes)}
                  {f.uploaded_at && ` \u00b7 ${formatDate(f.uploaded_at)}`}
                </span>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleDelete(f.filename); }}
                className="text-[10px] text-red-400 hover:text-red-600 ml-2 shrink-0"
              >
                &times; Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
