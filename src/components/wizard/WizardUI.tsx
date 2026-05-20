'use client';

import React from 'react';
import { CheckCircle } from 'lucide-react';

interface ToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    icon: React.ElementType;
    color: string;
    title: string;
    desc: string;
}

export function Toggle({ checked, onChange, icon: Icon, color, title, desc }: ToggleProps) {
    return (
        <div 
            onClick={() => onChange(!checked)}
            className={`flex items-start gap-4 p-4 border rounded-xl cursor-pointer transition-all duration-200 group ${
                checked 
                 ? 'bg-blue-50/50 dark:bg-blue-600/10 border-blue-200 dark:border-blue-800 ring-1 ring-blue-200 dark:ring-blue-800' 
                 : 'bg-white dark:bg-gray-900/40 border-gray-200 dark:border-gray-800 hover:border-blue-300 dark:hover:border-blue-700 hover:bg-gray-50/50 dark:hover:bg-blue-900/5 shadow-sm hover:shadow-md'
            }`}
        >
            <div className={`mt-0.5 p-2.5 rounded-lg transition-colors ${
                checked ? 'bg-blue-100 dark:bg-blue-500/20 ' + color : 'bg-gray-100 dark:bg-gray-800 text-gray-400 group-hover:text-blue-400'
            }`}>
                <Icon className="w-5 h-5" />
            </div>
            <div className="flex-1">
                <div className={`font-semibold text-sm transition-colors ${checked ? 'text-blue-900 dark:text-blue-100' : 'text-gray-700 dark:text-gray-300 group-hover:text-blue-600 dark:group-hover:text-blue-400'}`}>{title}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed mt-0.5">{desc}</div>
            </div>
            <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${
                checked ? 'bg-blue-600 border-blue-600 scale-110 shadow-sm' : 'border-gray-300 dark:border-gray-700 group-hover:border-blue-400'
            }`}>
                {checked && <CheckCircle className="w-4 h-4 text-white" />}
            </div>
        </div>
    )
}

interface InputProps {
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    type?: string;
    hint?: string;
    error?: string;
}

export function Input({ label, value, onChange, placeholder, type = 'text', hint, error }: InputProps) {
   return (
      <div className="space-y-1.5">
        <label className="block text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider ml-1">{label}</label>
        <input
            type={type}
            className={`w-full px-4 py-2.5 bg-white dark:bg-gray-900/60 border rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm transition-all shadow-sm ${
                error ? 'border-red-400 dark:border-red-600' : 'border-gray-200 dark:border-gray-800 focus:border-blue-500'
            }`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
        />
        {hint && !error && <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1 ml-1">{hint}</p>}
        {error && <p className="text-[11px] text-red-500 mt-1 ml-1">{error}</p>}
    </div>
   )
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
}

export function Button({ children, onClick, disabled, className, variant = 'primary', ...props }: ButtonProps) {
    const variants = {
        primary: 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-500/20 premium-gradient',
        secondary: 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-500/20',
        outline: 'bg-transparent border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800',
        ghost: 'bg-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100/50 dark:hover:bg-gray-800/50'
    };

    return (
        <button 
            onClick={onClick} 
            disabled={disabled}
            className={`px-6 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed shadow-md hover:shadow-lg active:scale-95 ${variants[variant]} ${className}`}
            {...props}
        >
            {children}
        </button>
    )
}
