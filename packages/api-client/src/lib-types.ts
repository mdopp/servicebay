// Type re-exports from `@/lib/*` that the frontend needs. Phase 3.2
// (#763) routes the frontend through `@servicebay/api-client` so the
// future `packages/frontend/` package has no `@/lib/*` imports at all
// — the workspace boundary then becomes structurally enforceable.
//
// Today these still re-export from `src/lib/*`. Phase 3.3 (#764)
// physically relocates the type definitions into this package once
// the backend has its own workspace home and the cycle is breakable.

export type { Template, VariableMeta } from '@/lib/registry';
export type { PodmanConnection } from '@/lib/nodes';
export type { TemplateTier } from '@/lib/templateTier';
export type { StackManifest } from '@/lib/template/stackContract';
export type { Check, CheckConfig, CheckType } from '@/lib/health/types';
export type { NodeTwin, GatewayState, ProxyState } from '@/lib/store/twin';
export type { NetworkGraph } from '@/lib/network/types';
export type { HistoryEntry } from '@/lib/history';
export type {
  Credential,
  CredentialUrlHost,
  CredentialUrlContext,
} from '@/lib/stackInstall/credentialsManifest';
export type {
  ServiceBundle,
  BundleValidation,
  BundleStackArtifacts,
  BundlePortSummary,
  BundleContainerSummary,
} from '@/lib/unmanaged/bundleShared';
export type { HumanizedYamlError } from '@/lib/util/humanizeYamlError';
