import { useDigitalTwinContext } from '@/providers/DigitalTwinProvider';

export function useDigitalTwin() {
  return useDigitalTwinContext();
}
