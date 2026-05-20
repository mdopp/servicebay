/**
 * Public API exports for ServiceBay SDK
 * These exports provide access to internal utilities that may be useful for extensions or third-party integrations
 */

// Quadlet Parser - for parsing Podman Quadlet/Systemd files
export { QuadletParser, parseQuadletFile, type QuadletDirectives } from '@/lib/quadlet/parser';

// Service Bundle utilities
export { ensureBundlePreview } from '@/lib/unmanaged/bundleBuilder';
export type { ServiceBundle } from '@/lib/unmanaged/bundleShared';
