import { useState, useRef, type DragEvent, type ChangeEvent } from 'react';

export interface UploadResult {
  entity_count: number;
  columns_found: string[];
  columns_missing: string[];
  all_columns: string[];
  filename: string;
}

interface CsvUploadInputProps {
  onUploadComplete: (result: UploadResult) => void;
  onError?: (message: string) => void;
  uploadUrl: string;
  submoduleId?: string;
  currentFileName: string | null;
  currentEntityCount: number;
  requiredColumns: string[];
}

export function CsvUploadInput({
  onUploadComplete,
  onError,
  uploadUrl,
  submoduleId,
  currentFileName,
  currentEntityCount,
  requiredColumns,
}: CsvUploadInputProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  };

  const uploadFile = async (file: File) => {
    if (!file.name.endsWith('.csv')) {
      onError?.('Please upload a CSV file');
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (submoduleId) formData.append('submodule_id', submoduleId);

      const resp = await fetch(uploadUrl, { method: 'POST', body: formData });
      const data = await resp.json();

      if (!resp.ok) {
        onError?.(data.error || `Upload failed (${resp.status})`);
        return;
      }

      onUploadComplete(data as UploadResult);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Uploading state
  if (isUploading) {
    return (
      <div className="border-2 border-dashed border-blue-300 bg-blue-50 rounded-lg p-4 text-center">
        <div className="inline-block animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500 mb-2" />
        <p className="text-xs text-blue-600">Uploading and parsing...</p>
      </div>
    );
  }

  // Show loaded file info
  if (currentFileName) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-green-600 text-sm">CSV</span>
            <div>
              <p className="text-sm font-medium text-green-800">{currentFileName}</p>
              <p className="text-xs text-green-600">{currentEntityCount} entities loaded</p>
            </div>
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-xs text-blue-600 hover:text-blue-800 px-2 py-1 rounded hover:bg-blue-50"
          >
            Replace
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>
    );
  }

  // Drag-drop upload zone
  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => fileInputRef.current?.click()}
      className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
        isDragging
          ? 'border-blue-400 bg-blue-50'
          : 'border-gray-300 hover:border-blue-400'
      }`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleFileChange}
        className="hidden"
      />
      <p className="text-xs text-gray-500">
        {isDragging ? 'Drop CSV here' : 'Drop CSV or click to browse'}
      </p>
      {requiredColumns.length > 0 && (
        <p className="text-[10px] text-gray-400 mt-1">
          Expected columns: {requiredColumns.join(', ')}
        </p>
      )}
    </div>
  );
}
