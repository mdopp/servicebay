// Utility re-exports from `@/lib/*` that the frontend needs. Phase 3.2
// (#763) routes the frontend through `@servicebay/api-client` so the
// future `packages/frontend/` package has no `@/lib/*` imports at all
// — the workspace boundary then becomes structurally enforceable.
//
// Today these still re-export from `src/lib/*`. Phase 3.3 (#764)
// physically relocates the helpers into this package or, for pure-UI
// utilities (network layout, view-model builders), into the frontend
// package itself.

export { logger } from '@/lib/logger';
export { humanizeError } from '@/lib/util/humanizeError';
export { humanizeYamlError } from '@/lib/util/humanizeYamlError';
export { isValidOperatorEmail, operatorEmailIssue } from '@/lib/operatorEmail';
export { parseTemplateLabel } from '@/lib/templateLabel';
export { buildServiceViewModel } from '@/lib/services/serviceViewModel';
export { getLayoutedElements } from '@/lib/network/layout';
export { groupVariablesByTemplate } from '@/lib/stackInstall/groupVariables';
export { buildBitwardenCsv } from '@/lib/stackInstall/credentialsManifest';
export {
  generateBundleStackArtifacts,
  sanitizeBundleName,
} from '@/lib/unmanaged/bundleShared';
