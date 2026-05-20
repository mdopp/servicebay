/**
 * Quadlet/Systemd Unit File Parser
 * 
 * Parses .container, .pod, .service, and .kube Quadlet files to extract
 * structured directives for dependency discovery and bundle analysis.
 * 
 * Supports INI-style format with [Section] headers and Key=Value pairs.
 */

export interface QuadletDirectives {
  // [Unit] section - systemd directives
  requires?: string[];        // Hard dependencies (comma or space-separated)
  after?: string[];           // Ordering constraints (comma or space-separated)
  wants?: string[];           // Soft dependencies
  bindsTo?: string[];         // Bidirectional dependencies
  conflicts?: string[];       // Services that conflict
  description?: string;       // Human-readable description

  // [Container] section - Quadlet-specific directives
  containerName?: string;     // ContainerName=...
  image?: string;             // Image=...
  pod?: string;               // Pod=... (reference to pod file)
  environment?: Record<string, string>; // Environment variables
  volumes?: string[];         // Volume=... directives
  environmentFiles?: string[]; // EnvironmentFile=... directives

  // [Pod] section - pod-specific directives
  podName?: string;           // PodName=...
  publishPorts?: Array<{
    hostPort?: number;
    containerPort?: number;
    protocol?: string;        // tcp or udp
    hostIp?: string;
  }>;

  // [Kube] section - kube-specific directives
  kubeYaml?: string;          // Yaml=... path
  autoUpdate?: string;        // AutoUpdate=registry|local|none

  // [Install] section
  wantedBy?: string[];        // WantedBy=...
  requiredBy?: string[];      // RequiredBy=...

  // Metadata
  sourceType?: 'container' | 'pod' | 'kube' | 'service';
  sourceFile?: string;        // For reference/debugging
}

/**
 * Parses a Quadlet/Systemd unit file and extracts structured directives.
 * Exported for public API use as documented in QUADLET_PARSER_USAGE.md
 */
// @knipignore - exported for public API
export class QuadletParser {
  private lines: string[];
  private currentSection: string = '';

  constructor(content: string) {
    this.lines = content.split('\n');
  }

  /**
   * Main parse method - returns all extracted directives
   */
  parse(): QuadletDirectives {
    const directives: QuadletDirectives = {};

    for (const line of this.lines) {
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Section header [SectionName]
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        this.currentSection = trimmed.slice(1, -1).toLowerCase();
        continue;
      }

      // Key=Value pair
      if (trimmed.includes('=')) {
        this.parseDirective(trimmed, directives);
      }
    }

    return directives;
  }

  /**
   * Parse a single Key=Value directive based on current section
   */
  private parseDirective(line: string, directives: QuadletDirectives): void {
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) return;

    const key = line.substring(0, eqIndex).trim();
    const value = line.substring(eqIndex + 1).trim();

    if (!key || !value) return;

    switch (this.currentSection) {
      case 'unit':
        this.parseUnitDirective(key, value, directives);
        break;
      case 'container':
        this.parseContainerDirective(key, value, directives);
        break;
      case 'pod':
        this.parsePodDirective(key, value, directives);
        break;
      case 'kube':
        this.parseKubeDirective(key, value, directives);
        break;
      case 'install':
        this.parseInstallDirective(key, value, directives);
        break;
      case 'service':
        // For generated .service files, some directives may be in [Service] section
        this.parseServiceDirective(key, value, directives);
        break;
      case 'x-container':
        // Generated .service files use X-Container to preserve Quadlet directives
        this.parseContainerDirective(key, value, directives);
        break;
    }
  }

  /**
   * Parse [Unit] section directives
   */
  private parseUnitDirective(
    key: string,
    value: string,
    directives: QuadletDirectives
  ): void {
    switch (key.toLowerCase()) {
      case 'requires':
        // Accumulate multiple Requires lines
        const newRequires = this.parseServiceList(value);
        directives.requires = [...(directives.requires || []), ...newRequires];
        break;
      case 'after':
        // Accumulate multiple After lines
        const newAfter = this.parseServiceList(value);
        directives.after = [...(directives.after || []), ...newAfter];
        break;
      case 'wants':
        const newWants = this.parseServiceList(value);
        directives.wants = [...(directives.wants || []), ...newWants];
        break;
      case 'bindsto':
        const newBindsTo = this.parseServiceList(value);
        directives.bindsTo = [...(directives.bindsTo || []), ...newBindsTo];
        break;
      case 'conflicts':
        const newConflicts = this.parseServiceList(value);
        directives.conflicts = [...(directives.conflicts || []), ...newConflicts];
        break;
      case 'description':
        directives.description = value;
        break;
      case 'sourcepath':
        directives.sourceFile = value;
        break;
    }
  }

  /**
   * Parse [Container] section directives
   */
  private parseContainerDirective(
    key: string,
    value: string,
    directives: QuadletDirectives
  ): void {
    switch (key.toLowerCase()) {
      case 'containername':
        directives.containerName = value;
        break;
      case 'image':
        directives.image = value;
        break;
      case 'pod':
        // Normalize pod reference (remove .pod extension if present)
        directives.pod = value.replace(/\.pod$/, '');
        break;
      case 'environment':
        if (!directives.environment) directives.environment = {};
        const [envKey, ...envValParts] = value.split('=');
        directives.environment[envKey] = envValParts.join('=');
        break;
      case 'environmentfile':
        if (!directives.environmentFiles) directives.environmentFiles = [];
        directives.environmentFiles.push(value);
        break;
      case 'volume':
        if (!directives.volumes) directives.volumes = [];
        directives.volumes.push(value);
        break;
    }
  }

  /**
   * Parse [Pod] section directives
   */
  private parsePodDirective(
    key: string,
    value: string,
    directives: QuadletDirectives
  ): void {
    switch (key.toLowerCase()) {
      case 'podname':
        directives.podName = value;
        break;
      case 'publishport':
        if (!directives.publishPorts) directives.publishPorts = [];
        directives.publishPorts.push(this.parsePublishPort(value));
        break;
    }
  }

  /**
   * Parse [Kube] section directives
   */
  private parseKubeDirective(
    key: string,
    value: string,
    directives: QuadletDirectives
  ): void {
    switch (key.toLowerCase()) {
      case 'yaml':
        directives.kubeYaml = value;
        break;
      case 'autoupdate':
        directives.autoUpdate = value;
        break;
    }
  }

  /**
   * Parse [Install] section directives
   */
  private parseInstallDirective(
    key: string,
    value: string,
    directives: QuadletDirectives
  ): void {
    switch (key.toLowerCase()) {
      case 'wantedby':
        // Don't add .service suffix for targets
        directives.wantedBy = value
          .split(/[,\s]+/)
          .map(s => s.trim())
          .filter(s => s.length > 0);
        break;
      case 'requiredby':
        // Don't add .service suffix for targets
        directives.requiredBy = value
          .split(/[,\s]+/)
          .map(s => s.trim())
          .filter(s => s.length > 0);
        break;
    }
  }

  /**
   * Parse [Service] section (for generated .service files)
   */
  private parseServiceDirective(
    key: string,
    value: string,
    directives: QuadletDirectives
  ): void {
    // SourcePath points back to the original .container/.pod file
    if (key.toLowerCase() === 'sourcepath') {
      directives.sourceFile = value;
    }
  }

  /**
   * Parse PublishPort directive
   * Format: PublishPort=192.168.1.1:8080:80/tcp
   *         PublishPort=8080:80
   *         PublishPort=80
   */
  private parsePublishPort(value: string): {
    hostPort?: number;
    containerPort?: number;
    protocol?: string;
    hostIp?: string;
  } {
    const result: {
      hostPort?: number;
      containerPort?: number;
      protocol?: string;
      hostIp?: string;
    } = {};

    // Remove protocol suffix if present
    let protocol = 'tcp';
    let portPart = value;

    if (value.includes('/')) {
      const parts = value.split('/');
      portPart = parts[0];
      protocol = parts[1].toLowerCase();
    }

    result.protocol = protocol;

    // Parse address:hostPort:containerPort or just port
    const colonParts = portPart.split(':');

    if (colonParts.length === 3) {
      // hostIp:hostPort:containerPort
      result.hostIp = colonParts[0] || undefined;
      result.hostPort = parseInt(colonParts[1], 10) || undefined;
      result.containerPort = parseInt(colonParts[2], 10) || undefined;
    } else if (colonParts.length === 2) {
      // hostPort:containerPort
      result.hostPort = parseInt(colonParts[0], 10) || undefined;
      result.containerPort = parseInt(colonParts[1], 10) || undefined;
    } else if (colonParts.length === 1) {
      // Just containerPort (implicit hostPort=containerPort)
      const port = parseInt(colonParts[0], 10);
      if (port) {
        result.hostPort = port;
        result.containerPort = port;
      }
    }

    return result;
  }

  /**
   * Parse comma or space-separated service list
   * Supports: "service1.service, service2.service" or "service1.service service2.service"
   */
  private parseServiceList(value: string): string[] {
    return value
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => (s.endsWith('.service') ? s : `${s}.service`));
  }

  /**
   * Detect the source file type based on content
   */
  static detectSourceType(
    content: string
  ): 'container' | 'pod' | 'kube' | 'service' | 'unknown' {
    const lower = content.toLowerCase();

    if (lower.includes('[container]')) return 'container';
    if (lower.includes('[pod]')) return 'pod';
    if (lower.includes('[kube]')) return 'kube';
    if (lower.includes('[unit]') && lower.includes('[service]'))
      return 'service';

    return 'unknown';
  }
}

/**
 * Convenience function to parse a file and get directives
 */
export function parseQuadletFile(content: string): QuadletDirectives {
  const parser = new QuadletParser(content);
  return parser.parse();
}
