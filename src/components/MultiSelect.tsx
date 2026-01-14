import React, { useState, useEffect, useRef } from 'react';
import { X, Check, ChevronDown } from 'lucide-react';

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
        className={`flex flex-wrap items-center gap-1 p-1.5 border rounded bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600 min-h-[38px] cursor-text ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        onClick={() => {
            if (!disabled) {
                setIsOpen(true);
                inputRef.current?.focus();
            }
        }}
      >
        {value.map(v => (
          <span key={v} className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200 rounded">
            {v}
            <button onMouseDown={(e) => removeValue(v, e)} className="hover:text-blue-600 dark:hover:text-blue-100">
                <X size={12} />
            </button>
          </span>
        ))}
        
        <input
          ref={inputRef}
          type="text"
          className="flex-1 min-w-[60px] bg-transparent outline-none text-sm dark:text-gray-100"
          placeholder={value.length === 0 ? placeholder : ''}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onFocus={() => setIsOpen(true)}
          disabled={disabled}
        />
        
        {loading ? (
             <div className="animate-spin h-4 w-4 border-2 border-slate-500 rounded-full border-t-transparent mr-1"></div>
        ) : (
            <ChevronDown size={16} className="text-slate-400 mr-1" />
        )}
      </div>

      {isOpen && !disabled && (
        <ul className="absolute z-50 w-full mt-1 max-h-60 overflow-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded shadow-lg">
          {filteredOptions.length === 0 && (
             <li className="p-2 text-sm text-slate-500 dark:text-slate-400">No options found</li>
          )}
          {filteredOptions.map((option) => {
            const isSelected = value.includes(option);
            return (
                <li
                key={option}
                className={`flex items-center justify-between p-2 text-sm cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700 ${isSelected ? 'bg-slate-50 dark:bg-slate-700/50' : ''}`}
                onMouseDown={(e) => {
                    e.preventDefault(); // Prevent blur/click-outside
                    toggleOption(option);
                }}
                >
                <span className="dark:text-gray-200">{option}</span>
                {isSelected && <Check size={14} className="text-blue-600 dark:text-blue-400" />}
                </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
