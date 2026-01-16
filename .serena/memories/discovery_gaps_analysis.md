# Discovery Process Gaps Analysis

## Current State
The discovery process captures:
- `ServiceUnit.associatedContainerIds` - which containers a service manages
- `ServiceUnit.path` / `ServiceUnit.fragmentPath` - paths to unit files
- `PublishPort` parsing from `.pod` files (in some places)
- Basic container-to-pod associations

## Missing Relationship Information
From Quadlet files, we're NOT capturing:

### From `.container` files:
- `Requires=` - hard dependencies (service won't start without these)
- `After=` - ordering constraints
- `Pod=immich.pod` - which pod this container joins
- `BindsTo=` - bidirectional dependency with pod

### From `.pod` files:
- `PublishPort=` - port mappings (partially captured)
- Dependencies between pods

### From generated `.service` files:
- `X-Container` section with full container configuration
- `SourcePath=` linking back to original `.container` file
- Full dependency metadata

## Discovery Goal
Build a complete dependency tree:
```
Service (.kube) → Containers → Pod → PublishPorts
  ↓
Service (.container) → Pod (.pod) → PublishPorts & Dependencies
Service (.container) → Requires=other.service → other.pod
```

This enables automatic generation of equivalent `.kube` stacks that preserve all relationships.

## Key Insight from User Example
The `immich-server.container` example shows:
1. It references `immich-redis.service` and `immich-database.service` via `Requires=`
2. It joins `immich.pod` via `Pod=immich.pod`
3. The `immich.pod` file defines `PublishPort=2283:2283`
4. All this together means: "start immich with redis+database deps, running in a pod, exposing port 2283"

The current code can see parts of this but doesn't connect them into a coherent service bundle graph.
