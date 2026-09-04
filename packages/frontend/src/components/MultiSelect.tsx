import React, { useState, useEffect, useRef } from 'react';
import { X, Check, ChevronDown } from 'lucide-react';
import { Button, Input } from '@/components/ui';

interface MultiSelectProps {
  options: string[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  loading?: boolean;
}

export const MultiSelect: React.FC<MultiSelectProps> = ({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  className = '',
  disabled,
  loading
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredOptions = options.filter(opt => 
    opt.toLowerCase().includes(filter.toLowerCase())
  );

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [wrapperRef]);

  const toggleOption = (option: string) => {
    if (value.includes(option)) {
      onChange(value.filter(v => v !== option));
    } else {
      onChange([...value, option]);
    }
    // Keep focus
    inputRef.current?.focus();
  };

  const removeValue = (v: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(value.filter(val => val !== v));
  };

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <div
        className={`flex flex-wrap items-center gap-1 p-1.5 border rounded bg-surface-2 border-border min-h-[38px] cursor-text ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        onClick={() => {
            if (!disabled) {
                setIsOpen(true);
                inputRef.current?.focus();
            }
        }}
      >
        {value.map(v => (
          <span key={v} className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-accent/10 text-accent rounded">
            {v}
            <Button variant="ghost" onMouseDown={(e) => removeValue(v, e)} className="h-auto p-0 text-inherit hover:text-accent-strong">
                <X size={12} />
            </Button>
          </span>
        ))}
        
        <Input
          ref={inputRef}
          type="text"
          className="flex-1 min-w-[60px] bg-transparent outline-none text-sm text-text"
          placeholder={value.length === 0 ? placeholder : ''}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onFocus={() => setIsOpen(true)}
          disabled={disabled}
        />
        
        {loading ? (
             <div className="animate-spin h-4 w-4 border-2 border-text-muted rounded-full border-t-transparent mr-1"></div>
        ) : (
            <ChevronDown size={16} className="text-muted mr-1" />
        )}
      </div>

      {isOpen && !disabled && (
        <ul className="absolute z-50 w-full mt-1 max-h-60 overflow-auto bg-surface-2 border border-border rounded shadow-lg">
          {filteredOptions.length === 0 && (
             <li className="p-2 text-sm text-muted">No options found</li>
          )}
          {filteredOptions.map((option) => {
            const isSelected = value.includes(option);
            return (
                <li
                key={option}
                className={`flex items-center justify-between p-2 text-sm cursor-pointer hover:bg-surface ${isSelected ? 'bg-surface' : ''}`}
                onMouseDown={(e) => {
                    e.preventDefault(); // Prevent blur/click-outside
                    toggleOption(option);
                }}
                >
                <span className="text-text">{option}</span>
                {isSelected && <Check size={14} className="text-accent" />}
                </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
