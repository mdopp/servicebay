"""
Quadlet/Systemd Unit File Parser for Python

Parses .container, .pod, .service, and .kube Quadlet files to extract
structured directives for dependency discovery and bundle analysis.
"""

from typing import Dict, List, Optional, Any


class QuadletDirectives:
    """Container for parsed Quadlet directives"""

    def __init__(self):
        # [Unit] section
        self.requires: List[str] = []
        self.after: List[str] = []
        self.wants: List[str] = []
        self.bindsTo: List[str] = []
        self.conflicts: List[str] = []
        self.description: Optional[str] = None

        # [Container] section
        self.containerName: Optional[str] = None
        self.image: Optional[str] = None
        self.pod: Optional[str] = None
        self.environment: Dict[str, str] = {}
        self.volumes: List[str] = []
        self.environmentFiles: List[str] = []

        # [Pod] section
        self.podName: Optional[str] = None
        self.publishPorts: List[Dict[str, Any]] = []

        # [Kube] section
        self.kubeYaml: Optional[str] = None
        self.autoUpdate: Optional[str] = None

        # [Install] section
        self.wantedBy: List[str] = []
        self.requiredBy: List[str] = []

        # Metadata
        self.sourceType: Optional[str] = None
        self.sourceFile: Optional[str] = None
        self.parseLog: List[str] = []

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            'requires': self.requires,
            'after': self.after,
            'wants': self.wants,
            'bindsTo': self.bindsTo,
            'conflicts': self.conflicts,
            'description': self.description,
            'containerName': self.containerName,
            'image': self.image,
            'pod': self.pod,
            'environment': self.environment,
            'volumes': self.volumes,
            'environmentFiles': self.environmentFiles,
            'podName': self.podName,
            'publishPorts': self.publishPorts,
            'kubeYaml': self.kubeYaml,
            'autoUpdate': self.autoUpdate,
            'wantedBy': self.wantedBy,
            'requiredBy': self.requiredBy,
            'sourceType': self.sourceType,
            'sourceFile': self.sourceFile,
            'parseLog': self.parseLog,
        }


class QuadletParser:
    """Parser for Quadlet/Systemd unit files"""

    def __init__(self, content: str):
        self.content = content
        self.lines = content.split('\n')
        self.current_section = ''
        self.has_unit_section = False
        self.has_container_section = False
        self.has_pod_section = False
        self.has_kube_section = False

    def parse(self) -> QuadletDirectives:
        """Parse content and return directives"""
        directives = QuadletDirectives()

        directives.parseLog.append(f"Parsing Quadlet content ({len(self.lines)} lines)")

        for line in self.lines:
            trimmed = line.strip()

            # Skip empty lines and comments
            if not trimmed or trimmed.startswith('#'):
                continue

            # Section header [SectionName]
            if trimmed.startswith('[') and trimmed.endswith(']'):
                self.current_section = trimmed[1:-1].lower()
                directives.parseLog.append(f"Entered section [{self.current_section}]")
                if self.current_section == 'unit':
                    self.has_unit_section = True
                elif self.current_section == 'container':
                    self.has_container_section = True
                elif self.current_section == 'pod':
                    self.has_pod_section = True
                elif self.current_section == 'kube':
                    self.has_kube_section = True
                continue

            # Key=Value pair
            if '=' in trimmed:
                self._parse_directive(trimmed, directives)

        return directives

    def _parse_directive(self, line: str, directives: QuadletDirectives):
        """Parse a single Key=Value directive"""
        eq_index = line.find('=')
        if eq_index == -1:
            return

        key = line[:eq_index].strip()
        value = line[eq_index + 1:].strip()

        if not key or not value:
            return

        if self.current_section == 'unit':
            self._parse_unit_directive(key, value, directives)
        elif self.current_section == 'container':
            self._parse_container_directive(key, value, directives)
        elif self.current_section == 'pod':
            self._parse_pod_directive(key, value, directives)
        elif self.current_section == 'kube':
            self._parse_kube_directive(key, value, directives)
        elif self.current_section == 'install':
            self._parse_install_directive(key, value, directives)
        elif self.current_section == 'service':
            self._parse_service_directive(key, value, directives)
        elif self.current_section == 'x-container':
            self._parse_container_directive(key, value, directives)

    def _parse_unit_directive(self, key: str, value: str, directives: QuadletDirectives):
        """Parse [Unit] section directives"""
        key_lower = key.lower()
        if key_lower == 'requires':
            # Append to existing list (multiple Requires= lines allowed)
            parsed = self._parse_service_list(value)
            directives.requires.extend(parsed)
            directives.parseLog.append(f"Unit.Requires += {parsed}")
        elif key_lower == 'after':
            # Append to existing list (multiple After= lines allowed)
            parsed = self._parse_service_list(value)
            directives.after.extend(parsed)
            directives.parseLog.append(f"Unit.After += {parsed}")
        elif key_lower == 'wants':
            # Append to existing list (multiple Wants= lines allowed)
            parsed = self._parse_service_list(value)
            directives.wants.extend(parsed)
            directives.parseLog.append(f"Unit.Wants += {parsed}")
        elif key_lower == 'bindsto':
            # Append to existing list (multiple BindsTo= lines allowed)
            parsed = self._parse_service_list(value)
            directives.bindsTo.extend(parsed)
            directives.parseLog.append(f"Unit.BindsTo += {parsed}")
        elif key_lower == 'conflicts':
            # Append to existing list (multiple Conflicts= lines allowed)
            parsed = self._parse_service_list(value)
            directives.conflicts.extend(parsed)
            directives.parseLog.append(f"Unit.Conflicts += {parsed}")
        elif key_lower == 'description':
            directives.description = value
            directives.parseLog.append(f"Unit.Description set")
        elif key_lower == 'sourcepath':
            directives.sourceFile = value
            directives.parseLog.append(f"Unit.SourcePath set to {value}")

    def _parse_container_directive(self, key: str, value: str, directives: QuadletDirectives):
        """Parse [Container] section directives"""
        key_lower = key.lower()
        if key_lower == 'containername':
            directives.containerName = value
            directives.parseLog.append(f"Container.ContainerName = {value}")
        elif key_lower == 'image':
            directives.image = value
            directives.parseLog.append(f"Container.Image = {value}")
        elif key_lower == 'pod':
            # Normalize pod reference
            directives.pod = value.replace('.pod', '')
            directives.parseLog.append(f"Container.Pod reference = {directives.pod}")
        elif key_lower == 'environment':
            # Environment=KEY=VALUE
            if '=' in value:
                env_key, _, env_val = value.partition('=')
                directives.environment[env_key] = env_val
                directives.parseLog.append(f"Container.Environment add {env_key}")
        elif key_lower == 'environmentfile':
            directives.environmentFiles.append(value)
            directives.parseLog.append(f"Container.EnvironmentFile += {value}")
        elif key_lower == 'volume':
            directives.volumes.append(value)
            directives.parseLog.append(f"Container.Volume += {value}")

    def _parse_pod_directive(self, key: str, value: str, directives: QuadletDirectives):
        """Parse [Pod] section directives"""
        key_lower = key.lower()
        if key_lower == 'podname':
            directives.podName = value
            directives.parseLog.append(f"Pod.PodName = {value}")
        elif key_lower == 'publishport':
            parsed = self._parse_publish_port(value)
            directives.publishPorts.append(parsed)
            directives.parseLog.append(f"Pod.PublishPort += {parsed}")

    def _parse_kube_directive(self, key: str, value: str, directives: QuadletDirectives):
        """Parse [Kube] section directives"""
        key_lower = key.lower()
        if key_lower == 'yaml':
            directives.kubeYaml = value
            directives.parseLog.append(f"Kube.Yaml = {value}")
        elif key_lower == 'autoupdate':
            directives.autoUpdate = value
            directives.parseLog.append(f"Kube.AutoUpdate = {value}")

    def _parse_install_directive(self, key: str, value: str, directives: QuadletDirectives):
        """Parse [Install] section directives"""
        key_lower = key.lower()
        if key_lower == 'wantedby':
            directives.wantedBy = self._parse_service_list(value)
            directives.parseLog.append(f"Install.WantedBy = {directives.wantedBy}")
        elif key_lower == 'requiredby':
            directives.requiredBy = self._parse_service_list(value)
            directives.parseLog.append(f"Install.RequiredBy = {directives.requiredBy}")

    def _parse_service_directive(self, key: str, value: str, directives: QuadletDirectives):
        """Parse [Service] section (for generated .service files)"""
        if key.lower() == 'sourcepath':
            directives.sourceFile = value
            directives.parseLog.append(f"Service.SourcePath set to {value}")

    def _parse_publish_port(self, value: str) -> Dict[str, Any]:
        """Parse PublishPort directive
        Format: 192.168.1.1:8080:80/tcp, 8080:80, or 80
        """
        result: Dict[str, Any] = {}

        # Remove protocol suffix if present
        protocol = 'tcp'
        port_part = value

        if '/' in value:
            port_part, protocol = value.rsplit('/', 1)
            result['protocol'] = protocol.lower()

        # Parse address:hostPort:containerPort or just port
        colon_parts = port_part.split(':')

        if len(colon_parts) == 3:
            # hostIp:hostPort:containerPort
            if colon_parts[0]:
                result['hostIp'] = colon_parts[0]
            try:
                result['hostPort'] = int(colon_parts[1])
                result['containerPort'] = int(colon_parts[2])
            except ValueError:
                pass
        elif len(colon_parts) == 2:
            # hostPort:containerPort
            try:
                result['hostPort'] = int(colon_parts[0])
                result['containerPort'] = int(colon_parts[1])
            except ValueError:
                pass
        elif len(colon_parts) == 1:
            # Just containerPort
            try:
                port = int(colon_parts[0])
                result['hostPort'] = port
                result['containerPort'] = port
            except ValueError:
                pass

        if 'protocol' not in result:
            result['protocol'] = 'tcp'

        return result

    def _parse_service_list(self, value: str) -> List[str]:
        """Parse comma or space-separated service list"""
        import re
        # Split by comma or whitespace
        items = re.split(r'[,\s]+', value)
        result = []
        for item in items:
            item = item.strip()
            if item:
                # Add .service suffix if not present
                if not item.endswith('.service'):
                    item = f"{item}.service"
                result.append(item)
        return result

    @staticmethod
    def detect_source_type(content: str) -> str:
        """Detect the source file type based on content"""
        lower = content.lower()

        if '[container]' in lower:
            return 'container'
        if '[pod]' in lower:
            return 'pod'
        if '[kube]' in lower:
            return 'kube'
        if '[unit]' in lower and '[service]' in lower:
            return 'service'

        return 'unknown'


def parse_quadlet_file(content: str) -> Dict[str, Any]:
    """Convenience function to parse a file and get directives as dict"""
    parser = QuadletParser(content)
    directives = parser.parse()
    directives.sourceType = QuadletParser.detect_source_type(content)
    directives.parseLog.append(
        f"Detected sourceType={directives.sourceType} | sections: unit={parser.has_unit_section}, container={parser.has_container_section}, pod={parser.has_pod_section}, kube={parser.has_kube_section}"
    )
    return directives.to_dict()
