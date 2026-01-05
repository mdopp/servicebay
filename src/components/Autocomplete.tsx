import React, { useState, useEffect, useRef } from 'react';

interface AutocompleteProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  loading?: boolean;
}

export const Autocomplete: React.FC<AutocompleteProps> = ({
  options,
  value,
  onChange,
  placeholder,
  className,
  disabled,
  loading
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [filteredOptions, setFilteredOptions] = useState<string[]>([]);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFilter(value);
  }, [value]);

  useEffect(() => {
    const lowerFilter = filter.toLowerCase();
    const filtered = options.filter(opt => 
      opt.toLowerCase().includes(lowerFilter)
    );
    setFilteredOptions(filtered.slice(0, 50)); // Limit to 50 results for performance
  }, [filter, options]);

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

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <div className="relative">
        <input
          type="text"
          className={`w-full p-2 border rounded bg-gray-50 dark:bg-gray-700 dark:border-gray-600 ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          placeholder={loading ? 'Loading...' : placeholder}
          value={filter}
          disabled={disabled || loading}
          onChange={(e) => {
            setFilter(e.target.value);
            onChange(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => !disabled && !loading && setIsOpen(true)}
        />
        {loading && (
          <div className="absolute right-2 top-2.5">
            <div className="animate-spin h-5 w-5 border-2 border-blue-500 rounded-full border-t-transparent"></div>
          </div>
        )}
      </div>
      {isOpen && !disabled && !loading && filteredOptions.length > 0 && (
        <ul className="absolute z-10 w-full mt-1 max-h-60 overflow-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg">
          {filteredOptions.map((option, index) => (
            <li
              key={index}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
              onClick={() => {
                onChange(option);
                setFilter(option);
                setIsOpen(false);
              }}
            >
              {option}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
