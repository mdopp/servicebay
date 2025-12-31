import React from 'react';

export const ServiceBayLogo = ({ size = 24, className = "" }: { size?: number, className?: string }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round" 
    className={className}
  >
    {/* Server Unit */}
    <rect x="4" y="2" width="16" height="10" rx="2" ry="2" />
    <line x1="8" y1="7" x2="8.01" y2="7" />
    <line x1="12" y1="7" x2="12.01" y2="7" />
    
    {/* Waves / Bay */}
    <path d="M2 17c5.5 0 5.5-3 11-3s5.5 3 11 3" />
    <path d="M2 21c5.5 0 5.5-3 11-3s5.5 3 11 3" />
  </svg>
);

export default ServiceBayLogo;
