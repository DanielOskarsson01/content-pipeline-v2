import { useRef, useCallback } from 'react';

interface UrlTextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * Multiline textarea for pasting URLs or entity data.
 * One URL/entity per line. Returns raw text to parent;
 * parsing into structured entities happens at the parent level.
 */
export function UrlTextarea({
  value,
  onChange,
  placeholder = 'https://example.com\nCompany Name; https://another.com\n...',
}: UrlTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange]
  );

  return (
    <div>
      <label className="block text-xs text-gray-600 mb-1 font-medium">
        Paste URLs or data
      </label>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        rows={4}
        className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-[#3B82F6] resize-y placeholder:text-gray-300"
      />
    </div>
  );
}

/**
 * Parse raw textarea text into entity objects. One line = one entity.
 * Supports formats:
 *   https://example.com           → name auto-derived from hostname
 *   example.com                   → name auto-derived from hostname
 *   Company Name; https://example.com  → explicit name + URL
 *   Company Name; example.com          → explicit name + URL
 */
export function parseTextareaToEntities(
  text: string,
  primaryColumn: string
): Record<string, unknown>[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      let name: string | undefined;
      let value = line;

      // Check for "Name; url" format (semicolon separator)
      const semicolonIdx = line.indexOf(';');
      if (semicolonIdx > 0) {
        const before = line.slice(0, semicolonIdx).trim();
        const after = line.slice(semicolonIdx + 1).trim();
        // Only treat as name;url if the part after semicolon looks like a URL/domain
        if (after && /^(https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,})/i.test(after)) {
          name = before;
          value = after;
        }
      }

      const entity: Record<string, unknown> = { [primaryColumn]: value };
      if (name) {
        entity.name = name;
      }

      // Auto-derive entity name from URL if not explicitly provided
      if (!entity.name) {
        try {
          const urlStr = /^https?:\/\//i.test(value) ? value : `https://${value}`;
          const hostname = new URL(urlStr).hostname.replace(/^www\./, '');
          entity.name = hostname.split('.')[0].charAt(0).toUpperCase() + hostname.split('.')[0].slice(1);
        } catch { /* ignore parse errors */ }
      }

      return entity;
    });
}
