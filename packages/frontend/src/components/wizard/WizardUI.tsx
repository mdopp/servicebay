'use client';

import React from 'react';
import { CheckCircle } from 'lucide-react';
import { Button as UIButton, Input as UIInput } from '@/components/ui';

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
                 ? 'bg-surface border-border ring-1 ring-border'
                 : 'bg-surface border-border hover:border-border hover:bg-surface-2 shadow-sm hover:shadow-md'
            }`}
        >
            <div className={`mt-0.5 p-2.5 rounded-lg transition-colors ${
                checked ? 'bg-accent/20 ' + color : 'bg-surface-2 text-text-muted group-hover:text-accent'
            }`}>
                <Icon className="w-5 h-5" />
            </div>
            <div className="flex-1">
                <div className={`font-semibold text-sm transition-colors ${checked ? 'text-accent' : 'text-text group-hover:text-accent'}`}>{title}</div>
                <div className="text-xs text-text-muted leading-relaxed mt-0.5">{desc}</div>
            </div>
            <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${
                checked ? 'bg-accent border-accent scale-110 shadow-sm' : 'border-border group-hover:border-accent'
            }`}>
                {checked && <CheckCircle className="w-4 h-4 text-on-accent" />}
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
        <label className="block text-[11px] font-bold text-text-muted uppercase tracking-wider ml-1">{label}</label>
        <UIInput
            type={type}
            className={`w-full px-4 py-2.5 bg-surface-2 border rounded-xl focus:ring-2 focus:ring-accent outline-none text-sm transition-all shadow-sm text-text ${
                error ? 'border-status-fail' : 'border-border focus:border-accent'
            }`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
        />
        {hint && !error && <p className="text-[11px] text-text-muted mt-1 ml-1">{hint}</p>}
        {error && <p className="text-[11px] text-status-fail mt-1 ml-1">{error}</p>}
    </div>
   )
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
}

export function Button({ children, onClick, disabled, className, variant = 'primary', ...props }: ButtonProps) {
    const variants = {
        primary: 'bg-accent hover:bg-accent-strong text-on-accent premium-gradient',
        secondary: 'bg-accent hover:bg-accent-strong text-on-accent',
        outline: 'bg-transparent border border-border text-text hover:bg-surface-2',
        ghost: 'bg-transparent text-text-muted hover:text-text hover:bg-surface-2'
    };

    return (
        <UIButton
            variant="ghost"
            onClick={onClick}
            disabled={disabled}
            className={`h-auto px-6 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed shadow-md hover:shadow-lg active:scale-95 ${variants[variant]} ${className}`}
            {...props}
        >
            {children}
        </UIButton>
    )
}
