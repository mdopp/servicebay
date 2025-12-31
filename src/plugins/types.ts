import { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';

export interface Plugin {
  id: string;
  name: string;
  icon: LucideIcon;
  component: ReactNode;
}
