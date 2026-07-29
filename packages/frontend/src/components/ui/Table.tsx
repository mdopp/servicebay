'use client';

import React from 'react';

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  children: React.ReactNode;
}

export function Table({ className = '', children, ...props }: TableProps) {
  return <table className={className} {...props}>{children}</table>;
}
