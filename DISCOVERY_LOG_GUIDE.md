# Debugging Quadlet Discovery - How to Use the Discovery Log

## The Problem You Found

When you viewed the `immich-server` bundle, the raw data showed:
```json
{
  "discoveryLog": [
    "Starting bundle discovery from root service: immich-server",
    "Found 1 related service(s) via dependency graph",
    "  [0] immich-server (requires: 0, after: 0, wants: 0)"
  ]
}
```

But the actual `immich-server.container` file has:
```
[Unit]
Requires=immich-redis.service
Requires=immich-database.service
After=immich-redis.service
After=immich-database.service
```

## Root Cause Analysis

The discovery log tells us **the agent is receiving a ServiceUnit with empty relationship fields**. This means one of these is happening:

1. **Agent not parsing the Quadlet file** - The parser isn't being called
2. **Parser returning empty dict** - The parser is called but returns nothing
3. **Parser output not being added to ServiceUnit** - The parsed values aren't being sent
4. **Service name mismatch** - The agent can't find `immich-redis.service` in the service list

## How to Debug Using the Discovery Log

### Check 1: Is the Service Being Found?
Look for: `"Found N related service(s) via dependency graph"`
- If N=1: The dependencies aren't being found
- If N>1: The dependency graph walking worked!

### Check 2: What Relationship Fields Does Each Service Have?
Look for: `[0] service-name (requires: X, after: Y, wants: Z, bindsTo: W)`
- If all are 0: The agent didn't parse the Quadlet file
- If some > 0: The parser found them but walkDependencies couldn't resolve them

### Check 3: Which Services Were Found?
Look for: Service names in relationship edges
- `→ Requires: immich-redis.service` means it found the directive
- If you see this but service not in bundle, the name doesn't match a real service

### Check 4: Were Assets Collected?
Look for: `"Service X: collected Y asset(s)"`
- If Y=0: Check if `fragmentPath` is set in the service
- If Y>0: Lists the file path and kind (container, pod, kube, etc.)

## Agent-Side Debugging

If the discoveryLog shows `(requires: 0, after: 0, wants: 0)`, add this to your agent logs:

```
[Agent Output]
Parsing Quadlet directives for immich-server: requires=2, after=2, wants=0
Service immich-server: fragmentPath=/home/mdopp/.config/containers/systemd/immich-server.container
```

If you DON'T see this message, the agent isn't parsing the Quadlet file.

## What Each Discovery Log Message Means

| Log Message | What It Tells You |
|---|---|
| `"Found N related service(s) via dependency graph"` | N services were grouped together from requires/after/wants |
| `"(requires: X, after: Y, wants: Z)"` | These relationship counts were in the parsed Quadlet directives |
| `"Service X: linked Y container(s)"` | Y containers matched this service by name or pod |
| `"Service X: no containers linked"` | No running containers found for this service (expected for YAML-only) |
| `"→ Requires: Y.service"` | Found a Requires directive pointing to Y.service |
| `"Service X: collected Y asset(s)"` | Found Y Quadlet files (.container, .pod, .kube) for this service |
| `"Service X: no assets found"` | No Quadlet files found (check fragmentPath is set) |

## The Fix Needed

For your example, you need the agent to:

1. ✅ Find `immich-server.service` in the service list
2. ✅ Read `/home/mdopp/.config/containers/systemd/immich-server.container`
3. ❌ **Parse the Quadlet file and extract `Requires=` and `After=` directives**
4. ✅ Add those to the ServiceUnit: `requires: ['immich-redis.service', 'immich-database.service']`
5. ✅ Send it to bundleBuilder
6. ✅ bundleBuilder walks dependencies and finds immich-redis and immich-database
7. ✅ Creates graph edges and displays them in the UI

## Verification

Once the agent is sending the Quadlet directives, the discovery log should show:

```json
{
  "discoveryLog": [
    "Starting bundle discovery from root service: immich-server",
    "Found 3 related service(s) via dependency graph",
    "  [0] immich-server (requires: 2, after: 2, wants: 0)",
    "  [1] immich-redis (requires: 0, after: 0, wants: 0)",
    "  [2] immich-database (requires: 0, after: 0, wants: 0)",
    "Service immich-server: no containers linked",
    "  → Requires: immich-redis.service",
    "  → Requires: immich-database.service",
    "  → After: immich-redis.service",
    "  → After: immich-database.service",
    "Service immich-server: collected 1 asset(s)",
    "    - /home/mdopp/.config/containers/systemd/immich-server.container (container)",
    "Service immich-redis: collected 1 asset(s)",
    "    - /home/mdopp/.config/containers/systemd/immich-redis.container (container)",
    "Service immich-database: collected 1 asset(s)",
    "    - /home/mdopp/.config/containers/systemd/immich-database.container (container)"
  ]
}
```

This tells the complete story of how the three services were discovered and grouped together!
