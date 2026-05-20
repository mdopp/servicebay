/**
 * PodmanConnection — shared connection record type (#601 cycle-break).
 *
 * Extracted leaf so `nodes.ts` and `executor.ts` can both import the
 * shape without forming a cycle. Before: nodes.ts owned the type,
 * executor.ts imported it, nodes.ts dynamically imported getExecutor
 * back from executor → 2-node cycle that depcruise flagged
 * (transitively also unblocks the 5/6-node agent cluster cycle).
 *
 * `Name` is the operator-facing label; `URI` is the SSH connection
 * string (`ssh://user@host:port`); `Identity` is the path to the
 * private key; `Default` flags the home node for fallback resolution.
 */

export interface PodmanConnection {
  Name: string;
  URI: string;
  Identity: string;
  Default: boolean;
}
