'use client';

import { useState, useEffect, useMemo, useRef, ReactNode } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  icon?: ReactNode;
  badge?: string;
  disabled?: boolean;
}

interface SelectProps {
  options: SelectOption[];
  value?: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  searchable?: boolean;
  emptyState?: string;
  compact?: boolean;
}

export function Select({
  options,
  value,
  onChange,
  placeholder = 'Select option',
  className = '',
  disabled = false,
  searchable = true,
  emptyState = 'No results',
  compact = false
}: SelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedOption = useMemo(() => options.find(opt => opt.value === value) ?? null, [options, value]);

  const filteredOptions = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return options;
    return options.filter(opt => {
      const labelMatch = opt.label.toLowerCase().includes(trimmed);
      const descMatch = opt.description?.toLowerCase().includes(trimmed);
      return labelMatch || !!descMatch;
    });
  }, [options, query]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setQuery('');
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        setQuery('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && searchable) {
      searchRef.current?.focus();
    }
  }, [isOpen, searchable]);

  const handleSelect = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setIsOpen(false);
    setQuery('');
  };

  const renderIcon = (option: SelectOption) => {
    if (option.icon) {
      return (
        <div className="w-8 h-8 rounded-full bg-surface-2 text-text-muted flex items-center justify-center">
          {option.icon}
        </div>
      );
    }
    const initial = option.label?.charAt(0).toUpperCase() || option.value.charAt(0).toUpperCase();
    return (
      <div className="w-8 h-8 rounded-full bg-accent/10 text-accent flex items-center justify-center text-sm font-semibold">
        {initial}
      </div>
    );
  };

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(open => !open)}
        className={`w-full ${compact ? 'min-w-0' : 'min-w-[220px]'} px-3 py-2 border rounded-card bg-surface border-border flex items-center justify-between gap-2 transition focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed ${disabled ? 'cursor-not-allowed' : ''}`}
        disabled={disabled}
      >
        {selectedOption ? (
          <div className="flex items-center gap-2 text-left min-w-0">
            {!compact && renderIcon(selectedOption)}
            <span className="text-sm font-medium text-text truncate">{selectedOption.label}</span>
          </div>
        ) : (
          <span className="text-sm text-text-subtle">{placeholder}</span>
        )}
        <ChevronDown size={16} className="text-text-muted shrink-0" />
      </button>

      {isOpen && (
        <div className="absolute z-40 mt-2 w-full rounded-card border border-border bg-surface shadow-xl">
          {searchable && (
            <div className="p-3 border-b border-border">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search..."
                  className="w-full pl-9 pr-3 py-2 text-sm rounded-card bg-surface-2 text-text border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
            </div>
          )}
          <ul className="max-h-64 overflow-y-auto py-1" role="listbox">
            {filteredOptions.length === 0 && (
              <li className="py-4 px-3 text-sm text-text-muted text-center">
                {emptyState}
              </li>
            )}
            {filteredOptions.map(option => {
              const isSelected = option.value === value;
              return (
                <li
                  key={option.value}
                  onClick={() => handleSelect(option)}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition hover:bg-surface-2 ${option.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {renderIcon(option)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text truncate">{option.label}</span>
                      {option.badge && (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-chip bg-accent/10 text-accent">
                          {option.badge}
                        </span>
                      )}
                    </div>
                    {option.description && (
                      <p className="text-xs text-text-muted truncate">{option.description}</p>
                    )}
                  </div>
                  {isSelected && <Check size={16} className="text-accent" />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
