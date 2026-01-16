# QuadletParser Usage Guide

## TypeScript Usage

### Basic Parsing

```typescript
import { QuadletParser, parseQuadletFile } from '@/lib/quadlet/parser';

// Method 1: Using class
const parser = new QuadletParser(fileContent);
const directives = parser.parse();

// Method 2: Using convenience function
const directives = parseQuadletFile(fileContent);
```

### Accessing Parsed Data

```typescript
interface QuadletDirectives {
  // [Unit] section
  requires?: string[];        // ['immich-redis.service', 'immich-database.service']
  after?: string[];           // ['immich-redis.service', 'immich-database.service']
  wants?: string[];
  bindsTo?: string[];
  conflicts?: string[];
  description?: string;       // "Immich Server"

  // [Container] section
  containerName?: string;     // "immich_server"
  image?: string;             // "ghcr.io/immich-app/immich-server:release"
  pod?: string;               // "immich" (from Pod=immich.pod)
  environment?: Record<string, string>;
  volumes?: string[];         // ['/data:/data', '/etc/localtime:/etc/localtime:ro']
  environmentFiles?: string[];

  // [Pod] section
  podName?: string;
  publishPorts?: Array<{
    hostPort?: number;        // 2283
    containerPort?: number;   // 2283
    protocol?: string;        // 'tcp' or 'udp'
    hostIp?: string;          // '192.168.1.1' (optional)
  }>;

  // [Kube] section
  kubeYaml?: string;          // "stack.yml"
  autoUpdate?: string;        // "registry"

  // [Install] section
  wantedBy?: string[];        // ['default.target']
  requiredBy?: string[];

  // Metadata
  sourceType?: string;        // 'container', 'pod', 'kube', 'service'
  sourceFile?: string;        // '/home/user/.config/containers/systemd/immich-server.container'
}
```

### Practical Examples

#### Example 1: Parse a .container file

```typescript
const containerContent = `
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
Volume=/data:/data
Volume=/etc/localtime:/etc/localtime:ro

[Service]
Restart=always
`;

const directives = parseQuadletFile(containerContent);

console.log(directives.requires);
// Output: ['immich-redis.service', 'immich-database.service']

console.log(directives.pod);
// Output: 'immich'

console.log(directives.image);
// Output: 'ghcr.io/immich-app/immich-server:release'

console.log(directives.volumes);
// Output: ['/data:/data', '/etc/localtime:/etc/localtime:ro']
```

#### Example 2: Parse a .pod file

```typescript
const podContent = `
[Unit]
Description=Immich Pod

[Pod]
PublishPort=80:80
PublishPort=443:443/tcp
PublishPort=192.168.1.1:2283:2283

[Install]
WantedBy=default.target
`;

const directives = parseQuadletFile(podContent);

console.log(directives.publishPorts);
// Output: [
//   { hostPort: 80, containerPort: 80, protocol: 'tcp' },
//   { hostPort: 443, containerPort: 443, protocol: 'tcp' },
//   { hostPort: 2283, containerPort: 2283, protocol: 'tcp', hostIp: '192.168.1.1' }
// ]

console.log(directives.wantedBy);
// Output: ['default.target']
```

#### Example 3: Source type detection

```typescript
const sourceType = QuadletParser.detectSourceType(content);

if (sourceType === 'container') {
  // Handle .container file
} else if (sourceType === 'pod') {
  // Handle .pod file
} else if (sourceType === 'kube') {
  // Handle .kube file
}
```

## Python Usage

### Basic Parsing

```python
from quadlet_parser import parse_quadlet_file, QuadletParser

# Method 1: Using convenience function
directives = parse_quadlet_file(file_content)

# Method 2: Using class
parser = QuadletParser(file_content)
directives_obj = parser.parse()
directives = directives_obj.to_dict()
```

### Accessing Parsed Data

```python
directives = parse_quadlet_file(content)

# All data returned as dictionary
directives['requires']      # ['immich-redis.service', ...]
directives['pod']           # 'immich'
directives['publishPorts']  # [{'hostPort': 2283, 'containerPort': 2283, ...}]
```

### Practical Example

```python
import json

# In agent.py fetch_services function:
for service in services:
    source_path = service_paths.get(service['name'])
    if source_path and os.path.exists(source_path):
        try:
            with open(source_path, 'r') as f:
                content = f.read()
            
            # Parse the Quadlet file
            quadlet_directives = parse_quadlet_file(content)
            
            # Add to service data
            service['requires'] = quadlet_directives.get('requires', [])
            service['after'] = quadlet_directives.get('after', [])
            service['podReference'] = quadlet_directives.get('pod')
            service['publishedPorts'] = quadlet_directives.get('publishPorts', [])
            
            log_debug(f"Parsed {source_path}: {quadlet_directives['sourceType']}")
        except Exception as e:
            log_debug(f"Failed to parse {source_path}: {e}")
```

## Integration in bundleBuilder

### Using Relationship Data

```typescript
// In buildServiceBundlesForNode function:

// Walk dependency graph
const walkDependencies = (rootService: ServiceUnit): ServiceUnit[] => {
  const related: ServiceUnit[] = [rootService];
  
  // Add all services that this service Requires
  (rootService.requires || []).forEach(req => {
    const depName = req.replace('.service', '');
    const depService = serviceMap.get(depName);
    if (depService) {
      related.push(...walkDependencies(depService));
    }
  });
  
  return related;
};

// Build bundle from all related services
const allRelated = walkDependencies(service);

// Create bundle hints from relationships
if (service.requires?.length > 0) {
  hints.add(`Hard dependencies: ${service.requires.join(', ')}`);
}

if (service.publishedPorts?.length > 0) {
  const ports = service.publishedPorts
    .map(p => `${p.hostPort}/${p.protocol}`)
    .join(', ');
  hints.add(`Published ports: ${ports}`);
}
```

## Real-World Example: Nginx Stack

```typescript
const nginxContent = `
[Unit]
Description=Nginx Reverse Proxy
Wants=network-online.target
After=network-online.target

[Container]
ContainerName=nginx
Image=docker.io/library/nginx:latest
Volume=/etc/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
PublishPort=80:80
PublishPort=443:443

[Service]
Restart=always
`;

const directives = parseQuadletFile(nginxContent);

// Use for UI display
console.log('Service:', directives.containerName);        // 'nginx'
console.log('Image:', directives.image);                  // 'docker.io/library/nginx:latest'
console.log('Ports:', directives.publishPorts?.map(p => `${p.hostPort}/${p.protocol}`).join(', '));
// Output: 'Ports: 80/tcp, 443/tcp'
```

## Error Handling

The parser is robust and handles edge cases gracefully:

```typescript
try {
  const directives = parseQuadletFile(malformedContent);
  
  // Even if malformed, returns partial results
  // Lines with valid Key=Value pairs are parsed
  // Invalid lines are skipped
  
  console.log(directives.requires); // May be undefined
} catch (e) {
  // Should rarely throw - defaults to empty/undefined
  console.error('Critical parse error:', e);
}
```

## Tips and Best Practices

1. **Always check for undefined**: New fields may not be present in all service files
   ```typescript
   const requires = service.requires || [];
   ```

2. **Handle multiple directives**: Files can have multiple `Requires=` lines
   ```typescript
   // Parser accumulates them automatically
   console.log(directives.requires); // All accumulated here
   ```

3. **Use source type detection**: Different file types have different fields
   ```typescript
   if (directives.sourceType === 'pod') {
     // publishPorts will likely be present
   }
   ```

4. **Port handling**: Supports multiple formats
   ```typescript
   // All valid:
   // PublishPort=80:80
   // PublishPort=8080:80
   // PublishPort=192.168.1.1:8080:80/tcp
   // PublishPort=80/udp
   ```

5. **Dependency ordering**: Respect the order of dependencies
   ```typescript
   // Requires=[A, B] means both are hard requirements
   // After=[B] means ordering constraint but may still start without B
   ```
