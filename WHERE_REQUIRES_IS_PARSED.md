# Where "Requires" is Parsed in the Code

## Complete Code Flow: Quadlet File → UI Display

### 1. Agent Side: Python Quadlet Parser

**Location**: `src/lib/agent/v4/quadlet_parser.py`

**Key Functions**:

```python
# Lines 130-136: Parse [Unit] section directives
def _parse_unit_directive(self, key: str, value: str, directives: QuadletDirectives):
    """Parse [Unit] section directives"""
    key_lower = key.lower()
    if key_lower == 'requires':
        directives.requires = self._parse_service_list(value)
    elif key_lower == 'after':
        directives.after = self._parse_service_list(value)
    elif key_lower == 'wants':
        directives.wants = self._parse_service_list(value)
```

**How it works**:
1. Reads the `.container` file content
2. Parses INI sections: `[Unit]`, `[Container]`, `[Pod]`, etc.
3. For each `Key=Value` line in `[Unit]`:
   - Converts key to lowercase for comparison
   - If key is "requires", calls `_parse_service_list(value)`
   - Stores result in `directives.requires` array

**Example**:
```
Input file:
[Unit]
Requires=immich-redis.service
Requires=immich-database.service

Output:
directives.requires = ['immich-redis.service', 'immich-database.service']
```

### 2. Agent Side: Service Discovery

**Location**: `src/lib/agent/v4/agent.py`

**Lines 961-976**: Parse Quadlet directives
```python
# Find the source Quadlet file for this service
source_path = service_paths.get(name)
if source_path and os.path.exists(source_path):
    try:
        with open(source_path, 'r') as f:
            file_content = f.read()
        quadlet_directives = parse_quadlet_file(file_content)
        if quadlet_directives:
            log_debug(f"Parsed Quadlet directives for {clean_name}: requires={len(quadlet_directives.get('requires', []))}")
    except Exception as e:
        log_debug(f"Failed to parse Quadlet directives for {source_path}: {e}")
```

**Lines 991-1009**: Add directives to ServiceUnit
```python
# Add Quadlet relationship fields if parsed
if quadlet_directives:
    if quadlet_directives.get('requires'):
        service_entry['requires'] = quadlet_directives['requires']
    if quadlet_directives.get('after'):
        service_entry['after'] = quadlet_directives['after']
    if quadlet_directives.get('wants'):
        service_entry['wants'] = quadlet_directives['wants']
```

**How it works**:
1. Maps service names to their source Quadlet files (e.g., `immich-server.service` → `/home/user/.config/containers/systemd/immich-server.container`)
2. For each service, reads its Quadlet file
3. Calls `parse_quadlet_file()` to extract directives
4. Adds the parsed values to `service_entry` dict
5. Sends ServiceUnit to backend via JSON

### 3. TypeScript Types

**Location**: `src/lib/agent/types.ts`

**Lines 96-99**: ServiceUnit interface
```typescript
export interface ServiceUnit {
  // ... other fields ...
  requires?: string[];
  after?: string[];
  wants?: string[];
  bindsTo?: string[];
  // ... more fields ...
}
```

### 4. Backend: Bundle Builder

**Location**: `src/lib/unmanaged/bundleBuilder.ts`

**Lines 197-229**: Walk dependency graph
```typescript
const walkDependencies = (rootService: ServiceUnit, visited = new Set<string>()): ServiceUnit[] => {
  if (visited.has(rootService.name)) return [];
  visited.add(rootService.name);

  const related: ServiceUnit[] = [rootService];
  const serviceMap = new Map<string, ServiceUnit>();
  services.forEach(s => serviceMap.set(s.name, s));

  // Walk Requires (hard dependencies)
  (rootService.requires || []).forEach(req => {
    const depName = req.replace('.service', '');
    const depService = serviceMap.get(depName);
    if (depService && !visited.has(depName)) {
      related.push(...walkDependencies(depService, visited));
    }
  });
  // Similar for after, wants...
}
```

**How it works**:
1. Takes a root service (e.g., `immich-server`)
2. Looks at its `requires` array (e.g., `['immich-redis.service', 'immich-database.service']`)
3. For each dependency, strips `.service` suffix to get service name
4. Looks up service in `serviceMap`
5. If found, recursively walks that service's dependencies
6. Returns all related services as one group

**Lines 271-338**: Create graph edges
```typescript
svc.requires?.forEach(dep => {
  graphEdges.push({
    from: svc.name,
    to: dep,
    reason: 'Requires'
  });
});
```

### 5. UI: Display Bundle

**Location**: `src/plugins/ServicesPlugin.tsx`

**Lines 1302-1318**: Dependency Graph display
```tsx
<section>
  <h5>Dependency Graph</h5>
  {detailBundle.graph.length === 0 ? (
    <p>No dependency hints detected.</p>
  ) : (
    <ul>
      {detailBundle.graph.map(edge => (
        <li key={`${edge.from}-${edge.to}-${edge.reason}`}>
          <span>{edge.from}</span>
          <ArrowRight />
          <span>{edge.to}</span>
          <span>{edge.reason}</span>
        </li>
      ))}
    </ul>
  )}
</section>
```

## Complete Data Flow Example

### Input: `immich-server.container`
```ini
[Unit]
Description=Immich Server
Requires=immich-redis.service
Requires=immich-database.service
After=immich-redis.service
After=immich-database.service

[Container]
Pod=immich.pod
ContainerName=immich_server
Image=ghcr.io/immich-app/immich-server:release
```

### Step 1: Python Parser Output
```python
{
  'requires': ['immich-redis.service', 'immich-database.service'],
  'after': ['immich-redis.service', 'immich-database.service'],
  'wants': [],
  'bindsTo': [],
  'pod': 'immich',
  'containerName': 'immich_server',
  'image': 'ghcr.io/immich-app/immich-server:release',
  'sourceType': 'container'
}
```

### Step 2: Agent ServiceUnit
```json
{
  "name": "immich-server",
  "fragmentPath": "/home/user/.config/containers/systemd/immich-server.container",
  "requires": ["immich-redis.service", "immich-database.service"],
  "after": ["immich-redis.service", "immich-database.service"],
  "podReference": "immich"
}
```

### Step 3: bundleBuilder Processing
```
1. Find immich-server in service list
2. Read requires = ['immich-redis.service', 'immich-database.service']
3. Strip '.service' → ['immich-redis', 'immich-database']
4. Look up 'immich-redis' in serviceMap → Found!
5. Look up 'immich-database' in serviceMap → Found!
6. Group all 3 into one bundle
7. Create graph edges:
   - immich-server → immich-redis.service [Requires]
   - immich-server → immich-database.service [Requires]
```

### Step 4: UI Bundle Output
```json
{
  "id": "atHome::immich-server",
  "services": [
    {"serviceName": "immich-server"},
    {"serviceName": "immich-redis"},
    {"serviceName": "immich-database"}
  ],
  "graph": [
    {"from": "immich-server", "to": "immich-redis.service", "reason": "Requires"},
    {"from": "immich-server", "to": "immich-database.service", "reason": "Requires"}
  ],
  "assets": [
    {"path": "/home/user/.config/containers/systemd/immich-server.container"},
    {"path": "/home/user/.config/containers/systemd/immich-redis.container"},
    {"path": "/home/user/.config/containers/systemd/immich-database.container"}
  ]
}
```

## Debugging Checklist

If `discoveryLog` shows `(requires: 0, after: 0, wants: 0)`:

1. ✅ **Check Python parser** - Run test on actual `.container` file
2. ✅ **Check agent logs** - Look for "Parsed Quadlet directives" message
3. ✅ **Check source_path** - Verify agent found the Quadlet file
4. ✅ **Check service name mapping** - Verify `service_paths` dict has correct mappings
5. ✅ **Check fragmentPath** - Verify agent sets `fragmentPath` in ServiceUnit
6. ✅ **Check bundleBuilder** - Verify `walkDependencies` can find the services

The detailed discoveryLog now shows ALL of this information!
