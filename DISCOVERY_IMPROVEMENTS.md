# Discovery Process Improvements

## Problem Statement

Your intuition is correct: **the current discovery process is not capturing enough relationship information from Quadlet files** to make intelligent bundling and kube stack generation decisions.

When you look at a `.container` file like `immich-server.container`, you see:
- **Hard dependencies**: `Requires=immich-redis.service` + `Requires=immich-database.service`
- **Ordering constraints**: `After=immich-redis.service` + `After=immich-database.service`
- **Pod membership**: `Pod=immich.pod`

And in the corresponding `.pod` file (`immich.pod`), you see:
- **Published ports**: `PublishPort=2283:2283`

All of this information forms a **complete service bundle definition**:
> "To run Immich, you need Redis + Database services, all in a pod, exposing port 2283"

However, the current system is **silently ignoring most of these relationships**. It only captures:
- Container ID → Service name matching
- Pod name matching
- Some PublishPort parsing (but not consistently)

## Why This Matters

Without deep relationship parsing, the system can't:
1. **Automatically discover that redis and database are *required* dependencies** of the immich service
2. **Group related services into a single bundle** (currently might treat them as separate unmanaged services)
3. **Generate an accurate kube stack** that preserves all the original intent
4. **Understand the deployment topology** (what depends on what)

## Current Architecture Overview

```
┌─────────────────────────────────────┐
│ Python Agent (src/lib/agent/v4/)    │
├─────────────────────────────────────┤
│ • fetch_services()                  │
│   → Reads systemctl output          │
│   → Matches containers by name      │
│   → Links associated container IDs  │
│                                     │
│ • fetch_files()                     │
│   → Reads .container, .pod files    │
│   → Returns raw file content        │
│   → NO parsing of relationships     │
└──────────────────────┬──────────────┘
                       │ WatchedFile[]
                       │ ServiceUnit[]
                       ▼
┌─────────────────────────────────────┐
│ Backend (src/lib/)                  │
├─────────────────────────────────────┤
│ • bundleBuilder.ts                  │
│   → Receives file content + services│
│   → Groups by pod names             │
│   → Heuristics for directory match  │
│   → NO relationship parsing         │
│                                     │
│ • Outputs: ServiceBundle[]          │
│   → Used by UI to show unmanaged    │
│     services + merge wizard         │
└─────────────────────────────────────┘
```

## Missing Data Structure

The `ServiceUnit` interface needs enrichment:

```typescript
// Current (partial):
export interface ServiceUnit {
  name: string;
  path: string;                    // Path to unit file
  associatedContainerIds?: string[];
  // ... more fields
}

// Needed (additions):
export interface ServiceUnit {
  // ... existing fields
  
  // NEW: Systemd relationships from [Unit] section
  requires?: string[];             // From Requires=
  after?: string[];                // From After=
  wants?: string[];                // From Wants=
  bindsTo?: string[];              // From BindsTo=
  
  // NEW: Quadlet-specific metadata
  podReference?: string;           // From Pod=immich.pod (for .container files)
  publishedPorts?: {               // From PublishPort= (for .pod files)
    hostPort: number;
    containerPort?: number;
    protocol?: string;
  }[];
  
  // NEW: Source file type
  sourceType?: 'kube' | 'container' | 'pod' | 'service';
}
```

## Implementation Plan

### Phase 1: Parser Infrastructure

Create `src/lib/quadlet/parser.ts`:

```typescript
export interface QuadletDirectives {
  // [Unit] section
  requires?: string[];
  after?: string[];
  wants?: string[];
  bindsTo?: string[];
  
  // [Container] section
  pod?: string;
  containerName?: string;
  image?: string;
  
  // [Pod] section
  publishPorts?: Array<{ host: number; container?: number; protocol?: string }>;
  
  // [Install] section
  wantedBy?: string[];
}

export class QuadletParser {
  parse(content: string): QuadletDirectives {
    // INI-like parser for systemd/Quadlet format
    // Returns structured directives
  }
}
```

### Phase 2: Agent Enhancement

Update `src/lib/agent/v4/agent.py`:

```python
def fetch_services(containers=None):
    # ... existing code ...
    
    # NEW: Parse relationships from service files
    for service in services:
        source_path = service_paths.get(service['name'])
        if source_path:
            with open(source_path) as f:
                content = f.read()
            
            directives = parse_quadlet_directives(content)
            service['requires'] = directives.get('requires', [])
            service['after'] = directives.get('after', [])
            service['podReference'] = directives.get('pod')
            # ... etc
```

### Phase 3: Backend Enhancement

Update `src/lib/unmanaged/bundleBuilder.ts` to use the new relationship data:

```typescript
// Instead of just matching by pod names and directories,
// walk the dependency graph:
function buildBundleFromService(
  service: ServiceUnit,
  allServices: ServiceUnit[]
): ServiceBundle {
  // Start with this service
  const bundleServices = new Set([service.name]);
  const bundleFiles = new Set([service.path, service.fragmentPath]);
  
  // Recursively add all dependencies
  function addDeps(serviceName: string, depth = 0) {
    if (depth > 10) return; // Prevent cycles
    
    const svc = allServices.find(s => s.name === serviceName);
    if (!svc) return;
    
    (svc.requires || []).forEach(req => {
      const cleanReq = req.replace('.service', '');
      if (!bundleServices.has(cleanReq)) {
        bundleServices.add(cleanReq);
        addDeps(cleanReq, depth + 1);
      }
    });
    
    (svc.after || []).forEach(aft => {
      const cleanAft = aft.replace('.service', '');
      if (!bundleServices.has(cleanAft)) {
        bundleServices.add(cleanAft);
        addDeps(cleanAft, depth + 1);
      }
    });
  }
  
  addDeps(service.name);
  
  // Collect all files and containers for services in bundle
  // ...
}
```

### Phase 4: UI Updates

The UI automatically benefits from better bundling:
- More accurate service groupings
- Better visualization of dependencies in the merge wizard
- Clearer migration scope

## Benefits

1. **Accuracy**: Discovery understands the *actual* relationships between services, not guesses
2. **Automation**: Can automatically group related services into bundles
3. **Better Migration**: Generated kube stacks preserve all original constraints
4. **Transparency**: UI can show users exactly what will change and why
5. **Safety**: Catch dependency issues *before* applying migrations

## Example: Immich Discovery

### Before (Current):
```
immich-server.service
  ├─ Container: immich_server
  └─ Pod: immich (found via name match)

immich-redis.service
  ├─ Container: immich_redis
  └─ Pod: immich (found via name match)

immich-database.service
  ├─ Container: immich_database
  └─ Pod: immich (found via name match)
```

**Problem**: Three separate bundles, no explicit relationship info

### After (Proposed):
```
immich Bundle (root: immich-server.service)
  ├─ Services:
  │  ├─ immich-server
  │  │  ├─ Requires: immich-redis.service, immich-database.service
  │  │  ├─ After: immich-redis.service, immich-database.service
  │  │  ├─ Pod: immich.pod
  │  │  └─ Container: immich_server
  │  ├─ immich-redis
  │  │  ├─ Pod: immich.pod
  │  │  └─ Container: immich_redis
  │  └─ immich-database
  │     ├─ Pod: immich.pod
  │     └─ Container: immich_database
  │
  ├─ Pod: immich
  │  └─ PublishPorts: [2283:2283]
  │
  └─ Files: [
       immich-server.container,
       immich-redis.container,
       immich-database.container,
       immich.pod
     ]
```

**Benefit**: Automatic grouping, clear dependency understanding, complete scope for migration

## Next Steps

1. **Read** the Python agent code to understand current file parsing
2. **Design** the QuadletParser class for robust INI-style parsing
3. **Implement** Phase 1 (Parser) and Phase 2 (Agent)
4. **Test** with your Immich example to verify relationships are captured
5. **Update** bundleBuilder to use the new data
6. **Validate** that generated kube stacks are accurate
