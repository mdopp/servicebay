import { useDigitalTwinContext } from '@/providers/DigitalTwinProvider';
import { DigitalTwinSnapshot } from '@/providers/DigitalTwinProvider';

export type { DigitalTwinSnapshot };

export function useDigitalTwin() {
  return useDigitalTwinContext();
}
