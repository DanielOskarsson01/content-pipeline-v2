import { useState, useRef, useEffect } from 'react';
import type { ProjectMode } from '../../types/step';

interface CreateDropdownProps {
  variant: 'hero' | 'inline';
  onSelect: (mode: ProjectMode) => void;
}

const ITEMS: { mode: ProjectMode; label: string; description: string; dividerAfter?: boolean }[] = [
  { mode: 'use_template', label: 'Use template', description: 'Start a run from an existing template' },
  { mode: 'update_template', label: 'Change template', description: 'Run and save changes back to template' },
  { mode: 'fork_template', label: 'Fork template', description: 'Copy template, customize independently', dividerAfter: true },
  { mode: 'single_run', label: 'Single run', description: 'One-off project, no template' },
  { mode: 'new_template', label: 'New template', description: 'Build a reusable template from scratch' },
];

export function CreateDropdown({ variant, onSelect }: CreateDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const isHero = variant === 'hero';

  return (
    <div ref={ref} className={`relative ${isHero ? 'inline-block' : ''}`}>
      <button
        onClick={() => setOpen(!open)}
        className={
          isHero
            ? 'px-6 py-3 bg-sky-600 hover:bg-sky-700 text-white text-base font-medium rounded-lg shadow-sm transition-colors'
            : 'px-3 py-1.5 bg-sky-600 hover:bg-sky-700 text-white text-sm rounded-lg font-medium transition-colors'
        }
      >
        Create...
      </button>

      {open && (
        <div className={`absolute z-50 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 ${isHero ? 'left-1/2 -translate-x-1/2 w-80' : 'right-0 w-72'}`}>
          {ITEMS.map((item) => (
            <div key={item.mode}>
              <button
                onClick={() => { onSelect(item.mode); setOpen(false); }}
                className="w-full text-left px-4 py-2.5 hover:bg-gray-50 transition-colors"
              >
                <div className="text-sm font-medium text-gray-900">{item.label}</div>
                <div className="text-[11px] text-gray-500">{item.description}</div>
              </button>
              {item.dividerAfter && <div className="border-t border-gray-100 my-1" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
