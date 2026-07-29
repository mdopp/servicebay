'use client';

import React from 'react';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  children: React.ReactNode;
}

export function Select({ className = '', children, ...props }: SelectProps) {
  return <select className={className} {...props}>{children}</select>;
}
