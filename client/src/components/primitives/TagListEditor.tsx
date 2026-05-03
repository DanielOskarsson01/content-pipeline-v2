import { useState, useCallback } from 'react';

interface TagListEditorProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}

/**
 * Simple tag/chip editor for string arrays.
 * Users type a value and press Enter or comma to add.
 * Click X to remove a tag.
 */
export function TagListEditor({ value, onChange, placeholder = 'Type and press Enter' }: TagListEditorProps) {
  const [input, setInput] = useState('');

  const addTag = useCallback((tag: string) => {
    const trimmed = tag.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setInput('');
  }, [value, onChange]);

  const removeTag = useCallback((index: number) => {
    onChange(value.filter((_, i) => i !== index));
  }, [value, onChange]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(input);
    }
    if (e.key === 'Backspace' && input === '' && value.length > 0) {
      removeTag(value.length - 1);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (text.includes(',')) {
      e.preventDefault();
      const tags = text.split(',').map(t => t.trim()).filter(Boolean);
      const unique = tags.filter(t => !value.includes(t));
      onChange([...value, ...unique]);
      setInput('');
    }
  };

  return (
    <div className="w-full bg-white border border-gray-300 rounded px-2 py-1.5 focus-within:border-[#0891B2] min-h-[38px] flex flex-wrap gap-1 items-center">
      {value.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          className="inline-flex items-center gap-1 bg-gray-100 border border-gray-200 rounded px-2 py-0.5 text-xs text-gray-700"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(i)}
            className="text-gray-400 hover:text-red-500 text-[10px] leading-none"
          >
            &times;
          </button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={() => { if (input.trim()) addTag(input); }}
        placeholder={value.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[80px] text-sm text-gray-900 outline-none bg-transparent py-0.5"
      />
    </div>
  );
}
