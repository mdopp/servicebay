# A living network map

[← back to FEATURES](../FEATURES.md)

ServiceBay keeps a real-time [Digital Twin](../ARCHITECTURE.md#the-digital-twin-data-model)
of every container, service, proxy route, port and DNS rewrite. The Network Map
renders that twin as an **Internet → Gateway → Service** topology — drawn from
what's actually running, not from a config file the operator has to keep in sync.

## What it does

- Draws the full chain: Internet → gateway (router) → host → proxy → service.
- Colours each service by live health.
- Derives edges from **five independent sources** (below), so a relationship shows
  up whether it's declared, observed, or merely implied by config.
- **Never leaves a service floating** — an otherwise-disconnected service is
  anchored to the host root so its card is always reachable in the graph.
- **Ego-focus drill-down** — click a service to reduce the map to its
  neighbourhood plus the Internet→service path.

## Why it exists

When something breaks and the operator doesn't know which piece is at fault —
DNS? proxy? the service? the container? — a static diagram is worthless. The map
is a *derived view* over the twin: as soon as the agent pushes a container update,
the graph reflects it. Dangling routes (a `proxy_pass` pointing at nothing
managed) surface as ghost nodes so they're found before users hit them.

## The edge sources

The provenance discriminator is `NetworkEdgeKind` in
`packages/backend/src/lib/network/types.ts`:
`'gateway' | 'proxy' | 'observed' | 'declared' | 'inferred' | 'manual'`.

| Source | Kind | Meaning |
|---|---|---|
| nginx proxy routes | `proxy` | An NPM `proxy_pass` to its actual target service. |
| Gateway port-forwards | `gateway` | Router → host port-forward (FritzBox etc.). |
| Template dependencies | `declared` | `servicebay.dependencies` from the pod manifest. |
| Live TCP flows | `observed` | Real socket flows sampled from `ss` on the host. |
| Container env references | `inferred` | An env value naming another service by `host:port`. |
| Operator-drawn | `manual` | Edges the operator added by hand. |

The **inferred-from-env** source is the clever one: it scans each service's
rendered pod-manifest `env` for a value like `http(s)://<host>:<port>` (or a bare
`<host>:<port>`); when `<host>` resolves to a known node in the graph, it emits a
`kind: 'inferred'` edge labelled with the env-var origin
(`packages/backend/src/lib/network/inferredEdges.ts`).

## Anchoring — no card floats

After all sources are merged and ubiquitous hub-spoke edges (auth/DNS) are
suppressed, any remaining edge-less `service` node is anchored to the host root
(`gateway`) with a single fallback `kind: 'inferred'` anchor edge
(`anchorFloatingNodes` in `inferredEdges.ts`, #2175). The anchor pass runs on the
*post-suppression* edge set, so a service whose only link was a suppressed hub
edge still gets anchored rather than floating.

## Ego-focus

Focus / ego mode (#1786) lives in the renderer: `focusNodeId` state +
`computeEgoNodeIds()` reduce the visible graph to the focus node's 1-hop
neighbourhood plus the Internet→focus path before layout, so the layout engine
lays out only the relevant subgraph and the camera zooms to it. The Services list
deep-links into it via `?focus=<service>` (#2108). Esc / clicking away restores
the full map.

## How it works — renderer & layout

The map is **ELK layered layout + React Flow**, not Cytoscape:

- **Layout:** `packages/backend/src/lib/network/layout.ts` imports
  `elkjs/lib/elk.bundled.js` and runs `elk.algorithm: 'layered'`,
  `elk.direction: 'RIGHT'` with orthogonal edge routing and layer-sweep crossing
  minimisation.
- **Renderer:** `packages/frontend/src/dashboards/NetworkDashboard.tsx` imports
  `ReactFlow` from `@xyflow/react` and defines a `CustomEdge` that renders ELK's
  orthogonal routing points as 90° polylines with line-hop geometry for crossings.
- **Aggregation:** `packages/backend/src/lib/network/service.ts` (`NetworkService`)
  reads the twin and merges the edge sources on demand; the graph is reactive over
  the twin, described in
  [ARCHITECTURE.md → Network Graph Aggregation](../ARCHITECTURE.md#5-network-graph-aggregation).

## Related

- [ARCHITECTURE.md](../ARCHITECTURE.md) — the Digital Twin data model and the
  data-lineage diagrams the map is derived from.
- [Diagnose](diagnose.md) — dangling-proxy and DNS-routing probes back the ghost
  nodes with one-click fixes.
