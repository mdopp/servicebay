import sys
import json
import time
import subprocess
import threading
import os
import glob
import platform
import socket
import shutil
import ctypes
import struct
import select
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional, Any

# --- types.py equivalent ---
@dataclass
class SystemResources:
    cpuUsage: float
    memoryUsage: int
    totalMemory: int
    diskUsage: float
    os: Optional[Dict[str, Any]] = None
    network: Optional[Dict[str, Any]] = None
    disks: Optional[List[Dict[str, Any]]] = None
    cpu: Optional[Dict[str, Any]] = None

@dataclass
class NodeStateSnapshot:
    resources: Optional[SystemResources]
    containers: List[Dict[str, Any]]
    services: List[Dict[str, Any]]
    volumes: List[Dict[str, Any]]
    files: Dict[str, Dict[str, Any]]
    proxy: List[Dict[str, Any]] # Added proxy routes
    timestamp: float

# --- Utilities ---
DEBUG_MODE = False

def log_debug(msg: str):
    if DEBUG_MODE:
        sys.stderr.write(f"[DEBUG] {msg}\n")
        sys.stderr.flush()

def run_command(cmd: List[str], check: bool = True) -> str:
    try:
        # Check if executable exists (simple check) to avoid FileNotFoundError crash
        result = subprocess.run(cmd, capture_output=True, text=True, check=check)
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        sys.stderr.write(f"Command failed: {cmd}, {e}\n")
        return ""
    except FileNotFoundError:
        sys.stderr.write(f"Binary not found for command: {cmd[0]}\n")
        sys.stderr.flush()
        return ""
    except Exception as e:
        sys.stderr.write(f"Unexpected error running {cmd}: {e}\n")
        sys.stderr.flush()
        return ""

# --- Monitors ---

class PodmanMonitor(threading.Thread):
    def __init__(self, callback):
        super().__init__()
        self.callback = callback
        self.daemon = True

    def run(self):
        # Watch for events
        # Use --stream=false to ensure the process exits if no events are immediately available, 
        # but we WANT a stream.
        # The leak comes from 'podman events' being spawned in a thread that might be restarted/orphaned 
        # OR multiple spawned processes.
        # Actually, if the agent restarts (e.g. via Next.js dev reload), the old python process dies, 
        # and so should its children (Popen with default args doesn't automatically kill children but OS should cleanup)
        # However, if 'podman events' is blocking, it might hang around?
        
        # FIX: Ensure we close the process on exit
        proc = subprocess.Popen(
            ['podman', 'events', '--format', 'json'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        self.proc = proc # Keep reference
        
        try:
            self.callback('init') # Initial fetch
            for line in proc.stdout:
                try:
                    event = json.loads(line)
                
                    # Filter noisy events
                    # We ignore exec-related events which are frequent (e.g. healthchecks)
                    action = event.get('Action', '')
                    status = event.get('Status', '') # Some versions use Status
                    
                    # Normalize action/status
                    act = action if action else status
                    
                    if act in ['exec_create', 'exec_start', 'exec_die', 'bind_mount', 'cleanup']:
                         continue
                         
                    log_debug(f"Podman Event: {act} ({event.get('Type')})")
                    self.callback('event')
                except Exception as e:
                    # Fallback: if json parsing fails or structure differs, trigger anyway to be safe,
                    # but limit it? No, safe to ignore parse errors usually means partial line.
                    pass
        except Exception as e:
            sys.stderr.write(f"Error in event loop: {e}\n")

class SystemdMonitor(threading.Thread):
    def __init__(self, callback):
        super().__init__()
        self.callback = callback
        self.daemon = True

    def run(self):
        # Initial scan
        self.callback('init')
        
        # V4.1: Polling removed in favor of event-driven updates (Container events + File changes)
        # We rely on:
        # 1. File changes -> Service definition changes
        # 2. Podman events -> Service state changes (Container starts/stops)
        # 3. Explicit 'refresh' commands from backend if needed (e.g. after manual reload)
        
        # Keep thread alive but inactive
        while True:
            time.sleep(3600) 


class ResourceMonitor(threading.Thread):
    def __init__(self, callback):
        super().__init__()
        self.callback = callback
        self.daemon = True

    def run(self):
        while True:
            self.callback()
            time.sleep(5)

# --- Fetchers ---


def get_host_ports_map():
    """
    Returns a map of PID -> List of {hostPort, containerPort, protocol}
    Calculated via 'ss -tulpnH' to find ports bound by processes.
    """
    pid_map = {} # PID -> List of ports
    
    # Robustly find 'ss'
    ss_path = shutil.which('ss')
    if not ss_path:
        # Fallback to standard locations
        extra_paths = ['/usr/bin/ss', '/bin/ss', '/usr/sbin/ss', '/sbin/ss']
        for p in extra_paths:
            if os.path.exists(p):
                ss_path = p
                break
    
    if not ss_path:
        sys.stderr.write("ERROR: 'ss' command not found on host. Host port detection will fail.\n")
        return {}

    log_debug(f"Using ss path: {ss_path}")
    # Force -n to avoid service name resolution, -H to skip header (if available) but handle output manually
    cmd = [ss_path, '-tulpn'] 
    
    try:
        # We handle execution manually here to ensure we catch stderr
        # run_command already handles it but we want strict ensure
        output = run_command(cmd)
        
        if not output:
             log_debug("ss command returned empty output")
             pass
        else:
             log_debug(f"ss command returned {len(output)} chars")
        
        for line in output.splitlines():
            parts = line.split()
            if len(parts) < 5: continue # Relaxed check
            
            # Netid State Recv-Q Send-Q Local_Address:Port Peer_Address:Port Process
            # tcp LISTEN 0 128 *:80 *:* users:(("nginx",pid=123,fd=4))
            
            # Find the column with Local_Address:Port
            # Usually column 4 (0-indexed) if "State" is present
            # But UDP 'UNCONN' is also a state.
            
            # Heuristic: Find column with ':' and port
            # Handle variable column layouts (with or without Netid)
            # Standard: Netid State Recv-Q Send-Q Local Peer
            # No-Netid: State Recv-Q Send-Q Local Peer
            
            protocol = 'tcp' # Default fallback
            local_idx = 4
            process_idx_start = 6
            
            start_col = parts[0].upper()
            known_states = ['LISTEN', 'UNCONN', 'ESTAB', 'TIME-WAIT', 'CLOSE-WAIT', 'SYN-SENT', 'SYN-RECV', 'FIN-WAIT-1', 'FIN-WAIT-2', 'CLOSE', 'CLOSING', 'LAST-ACK']
            
            if start_col in known_states:
                # No Netid column
                local_idx = 3
                process_idx_start = 5
                # Infer protocol
                if start_col == 'LISTEN': protocol = 'tcp'
                elif start_col == 'UNCONN': protocol = 'udp'
            elif len(parts) > 4:
                # Assume standard format: Netid State ...
                protocol = parts[0]
                local_idx = 4
                process_idx_start = 6

            # Bounds check
            if len(parts) <= local_idx: continue

            local = parts[local_idx]
            process_info = ' '.join(parts[process_idx_start:]) if len(parts) > process_idx_start else ''
            
            # Additional robustness: Ensure 'local' actually looks like an address (contains :)
            # If we misidentified columns, we might be looking at Recv-Q or something.
            if ':' not in local: 
                 # Try scanning for the first column with ':' that is NOT the last one (Peer is usually after Local)
                 # Actually Peer is right after Local.
                 found = False
                 for i, p in enumerate(parts):
                     if ':' in p:
                         # Check if next one also has ':' or is * (Peer)
                         if i+1 < len(parts) and (':' in parts[i+1] or parts[i+1] == '*'):
                             local = p
                             local_idx = i
                             # Recalculate protocol if possible?
                             found = True
                             break
                 if not found: continue

            if ':' in local:
                try:
                    last_colon = local.rfind(':')
                    port_str = local[last_colon+1:]
                    host_ip = local[:last_colon]
                    
                    # Normalize IP
                    if '%' in host_ip: continue # Skip link-local
                    if host_ip == '*' or host_ip == '' or host_ip == '::': host_ip = '0.0.0.0'
                    if host_ip.startswith('['): host_ip = host_ip.strip('[]')
                    
                    try:
                        port = int(port_str)
                    except ValueError: continue
                    
                    protocol = parts[0]
                    
                    # Extract PIDs
                    import re
                    # users:(("nginx",pid=123,fd=4),("rootlessport",pid=456,fd=3))
                    matches = re.finditer(r'pid=(\d+)', process_info)
                    for match in matches:
                        pid = int(match.group(1))
                        
                        if pid not in pid_map: pid_map[pid] = []
                        
                        # Deduplicate
                        exists = False
                        for p in pid_map[pid]:
                             if str(p['hostPort']) == str(port) and p['protocol'] == protocol:
                                 exists = True; break
                        
                        if not exists:
                            # log_debug(f"Mapped PID {pid} to {host_ip}:{port}/{protocol}")
                            pid_map[pid].append({
                                'hostIp': host_ip,
                                'hostPort': port,
                                'containerPort': port, # For host net, strict mapping
                                'protocol': protocol
                            })
                except Exception:
                    continue
    except Exception as e:
        sys.stderr.write(f"Error in get_host_ports_map: {e}\n")
        pass
    
    log_debug(f"Total PIDs with ports found: {len(pid_map.keys())}")
    return pid_map


def get_process_tree_map():
    """
    Returns a dictionary mapping PPID -> List[PID]
    Used to efficiently find all descendants of a container's main PID.
    """
    tree = {}
    try:
        # ps -e -o ppid= -o pid=
        # We explicitly request columns.
        cmd = ['ps', '-e', '-o', 'ppid,pid']
        output = run_command(cmd, check=False)
        
        for line in output.splitlines():
            parts = line.split()
            if len(parts) < 2: continue
            
            # Skip header if it contains non-digits
            if not parts[0].isdigit(): continue
            
            try:
                ppid = int(parts[0])
                pid = int(parts[1])
                
                if ppid not in tree:
                     tree[ppid] = []
                tree[ppid].append(pid)
            except ValueError:
                continue
    except Exception as e:
        pass
    return tree

def get_all_descendants(root_pid, tree):
    """
    Recursively finds all descendant PIDs using the pre-built tree.
    """
    if not root_pid or root_pid not in tree:
        return []
    
    descendants = []
    # Queue for BFS/DFS (Using list as queue)
    queue = tree[root_pid][:]
    seen = set(queue) # Avoid cycles if any
    
    idx = 0
    while idx < len(queue):
        current = queue[idx]
        idx += 1
        
        if current in tree:
            for child in tree[current]:
                if child not in seen:
                    seen.add(child)
                    queue.append(child)
            
    return queue

def fetch_containers():
    # Fetch enriched info: ports, mounts, networks
    # we use 'podman ps -a --format json' which is quite rich
    # We explicitly request PID to map host ports
    raw = run_command(['podman', 'ps', '-a', '--format', 'json'])
    
    # Pre-fetch host ports
    host_ports_map = get_host_ports_map()
    
    # Pre-fetch Process Tree for recursive PID scanning (Host Network Support)
    process_tree = get_process_tree_map()

    # Pre-fetch Pod Names if 'PodName' is missing in 'ps' output (Podman < 5 issue?)
    pod_name_map = {}
    try:
         # podman ps --format "{{.ID}}|{{.PodName}}" (Note: .ID is case sensitive in Go templates)
         # We use a custom format to force retrieval if JSON is flaky
         # podman < 5 uses .ID (capitalized) for template fields
         pod_out = run_command(['podman', 'ps', '-a', '--no-trunc', '--format', '{{.ID}}|{{.PodName}}'])
         for line in pod_out.splitlines():
             if '|' in line:
                 cid, pname = line.split('|', 1)
                 if pname.strip():
                     pod_name_map[cid.strip()] = pname.strip()
    except Exception:
        pass

    # Pre-fetch Network Modes via inspect (Fix for hostNetwork=false on Podman 4.x)
    network_mode_map = {}
    try:
        # Get all IDs first to bulk inspect
        all_ids_raw = run_command(['podman', 'ps', '-aq', '--no-trunc'])
        all_ids = [line.strip() for line in all_ids_raw.splitlines() if line.strip()]
        
        if all_ids:
             # Use check=False to avoid failure if a container is deleted during the process
             inspect_cmd = ['podman', 'inspect', '--format', '{{.Id}}|{{.HostConfig.NetworkMode}}'] + all_ids
             insp_out = run_command(inspect_cmd, check=False)
             for line in insp_out.splitlines():
                 if '|' in line:
                     cid, net_mode = line.split('|', 1)
                     network_mode_map[cid.strip()] = net_mode.strip()
    except Exception:
        pass

    try:
        containers = json.loads(raw) if raw else []
        # Normalization if needed to match EnrichedContainer
        enriched = []
        for c in containers:
            # FILTER: Skip Infra containers completely
            # They are implementation details of Pods and clutter the UI
            is_infra = c.get('IsInfra', False)
            names = c.get('Names', [])
            name = names[0] if isinstance(names, list) and names else str(names)
            
            # Fallback check by name if IsInfra is missing or false (older Podman versions)
            if not is_infra:
                # Common naming patterns for infra containers
                if name.endswith('-infra') or name.endswith('_infra'):
                    is_infra = True
            
            if is_infra:
                continue

            # Map fields to EnrichedContainer
            pid = c.get('Pid', 0)
            ports = c.get('Ports') or []
            names = c.get('Names', [])
            name = names[0] if isinstance(names, list) and names else str(names)
            
            # Host Network Check
            is_host_net = False
            networks = c.get('Networks', [])
            cid_full = c.get('Id', '')

            # Normalize networks to list
            networks_list = []
            if isinstance(networks, list):
                networks_list = networks[:] # Copy
                if 'host' in networks_list: is_host_net = True
            elif isinstance(networks, dict):
                networks_list = list(networks.keys())
                if 'host' in networks: is_host_net = True
            
            # 1. Trusted Side Channel (Inspect)
            # This fixes the bug where 'ps' JSON returns empty networks for host mode
            if cid_full and cid_full in network_mode_map:
                if network_mode_map[cid_full] == 'host':
                    is_host_net = True

            # Force 'host' into networks list if detected via side-channel
            if is_host_net and 'host' not in networks_list:
                networks_list.append('host')

            # Fallback: if ports are empty and we have a PID, it implies Host Network or Internal
            # We want to be aggressive finding ports for monitoring if standard ports are missing.
            
            detected = []
            
            if pid > 0:
                # V4.2: Recursive PID Scan
                # We check the main PID and all its descendants to find bound ports.
                pids_to_check = [pid]
                children = get_all_descendants(pid, process_tree)
                if children:
                    pids_to_check.extend(children)
                
                found_any = False
                for target_pid in pids_to_check:
                    if target_pid in host_ports_map:
                        detected.extend(host_ports_map[target_pid])
                        found_any = True
                
                if found_any:
                    log_debug(f"Container {name} (PID {pid}) matched ports via {len(pids_to_check)} PIDs scanned")
                elif c.get('State') == 'running':
                    log_debug(f"Container {name} (PID {pid}) - No ports found for {len(pids_to_check)} PIDs scanned.")
            
            if detected:
                # Deduplicate detected list first
                # (Can happen if multiple PIDs map to same port or repeated scans)
                unique_detected = []
                seen_det = set()
                
                # Sort to ensure consistent order (e.g. 80, 81, 443)
                detected.sort(key=lambda x: (x['hostPort'], x['protocol']))
                
                for dp in detected:
                    key = f"{dp['hostPort']}/{dp['protocol']}"
                    if key not in seen_det:
                        seen_det.add(key)
                        unique_detected.append(dp)
                
                if not ports: 
                    ports = unique_detected
                    log_debug(f"Assigned detected ports to {name}: {', '.join([str(p['hostPort']) for p in ports])}")
                else:
                    # Merge unique
                    for dp in unique_detected:
                        # Check against existing (some formats differ)
                        # Podman JSON Ports: [{hostPort, containerPort, protocol, range...}]
                        # Our SS Ports: {hostPort, containerPort, protocol, hostIp}
                        
                        # We use a loose check.
                        already_have = False
                        for ep in ports:
                            # Normalize
                            e_host = ep.get('hostPort') or ep.get('PublicPort')
                            e_proto = ep.get('protocol') or ep.get('Type') # udp/tcp
                            
                            if str(e_host) == str(dp['hostPort']) and str(e_proto).lower() == str(dp['protocol']).lower():
                                already_have = True; break
                        
                        if not already_have:
                            ports.append(dp)
                            log_debug(f"Merged detected port {dp['hostPort']} into {name}")

            # Normalize ports to ensure frontend gets consistent keys ({hostPort, containerPort, protocol})
            normalized_ports = []
            if ports:
                for p in ports:
                    # Handle primitive types (int/str) which can occur in some Podman versions or host-net scenarios
                    if isinstance(p, (int, str)):
                        normalized_ports.append({
                            'hostPort': p,
                            'containerPort': p,
                            'protocol': 'tcp' # Assume TCP for simple port list
                        })
                        continue

                    hp = p.get('hostPort') or p.get('host_port') or p.get('PublicPort')
                    cp = p.get('containerPort') or p.get('container_port') or p.get('PrivatePort')
                    # If we only have one port, assume it's the container port if host_port is missing? 
                    # Actually Podman usually gives at least containerPort.
                    
                    proto = p.get('protocol') or p.get('Type') or 'tcp'
                    
                    # Ensure we have at least one port to display
                    if hp is not None or cp is not None:
                         normalized_ports.append({
                             'hostPort': hp,
                             'containerPort': cp,
                             'protocol': proto
                         })
            
            # Pod Name Resolution
            pod_name = c.get('PodName', '') or pod_name_map.get(c.get('Id'), '')

            enriched.append({
                'id': c.get('Id'),
                'names': c.get('Names', []),
                'image': c.get('Image'),
                'state': c.get('State'),
                'status': c.get('Status'),
                'created': c.get('Created'),
                'ports': normalized_ports, 
                'mounts': c.get('Mounts') or [],
                'labels': c.get('Labels') or {},
                'networks': networks_list,
                'isHostNetwork': is_host_net,
                'podId': c.get('Pod', ''),
                'podName': pod_name,
                'isInfra': c.get('IsInfra', False),
                'pid': pid # Useful for debugging or further mapping
            })
        
        # Sort by ID to ensure consistent order for deduplication
        enriched.sort(key=lambda x: x['id'])
        return enriched
    except json.JSONDecodeError:
        return []

def fetch_volumes(containers=None):
    raw = run_command(['podman', 'volume', 'ls', '--format', 'json'])
    try:
        volumes = json.loads(raw) if raw else []
        
        # Enrich with Usage Data if containers provided
        if containers:
            # Create a map of VolumeName -> List of Containers
            usage_map = {}
            for c in containers:
                mounts = c.get('mounts', [])
                if not isinstance(mounts, list):
                    continue
                for m in mounts:
                    if not isinstance(m, dict): 
                        continue
                    if m.get('Type') == 'volume':
                        vol_name = m.get('Name')
                        if vol_name:
                            if vol_name not in usage_map:
                                usage_map[vol_name] = []
                            usage_map[vol_name].append({
                                'id': c['id'],
                                'name': c['names'][0] if c['names'] else c['id'][:12]
                            })
            
            # Merge into volumes
            for v in volumes:
                v['UsedBy'] = usage_map.get(v['Name'], [])
                
        volumes.sort(key=lambda x: x.get('Name', ''))
        return volumes
    except json.JSONDecodeError:
        return []

def fetch_services(containers=None):
    # systemctl --user list-units --type=service --all --output=json
    # Note: --output=json is available in newer systemd. Older ones might need parsing.
    # Fallback: parsing text?
    # Let's assume decently modern linux (Generic Linux with Podman usually means relatively new)
    raw = run_command(['systemctl', '--user', 'list-units', '--type=service', '--all', '--output=json'])
    try:
        units = json.loads(raw)
        
        # Filter for Quadlet services
        # We only want to show services that correspond to a definition file
        quadlet_dir = os.path.expanduser("~/.config/containers/systemd/")
        service_sources = {} # Map service_name -> extension
        service_paths = {} # Map service_name -> full_path
        
        # Scan for Quadlet source files that generate services
        # Recursive scan to match fetch_files behavior
        # We include .container/.pod to allow discovery of "Unmanaged/Legacy" Quadlets
        # But the Frontend will filter them out of the "Managed" list (Strict Kube-First)
        quadlet_exts = {'.kube', '.container', '.pod'}
        if os.path.exists(quadlet_dir):
            for filepath in glob.glob(os.path.join(quadlet_dir, "**/*"), recursive=True):
                 if os.path.isfile(filepath):
                    ext = os.path.splitext(filepath)[1]
                    if ext in quadlet_exts:
                         basename = os.path.basename(filepath)
                         # Quadlet maps filename.ext -> filename.service
                         service_name = os.path.splitext(basename)[0] + ".service"
                         service_sources[service_name] = ext
                         service_paths[service_name] = filepath

        # Also scan system-wide Quadlet directories (read-only usually, but valid services)
        system_quadlet_dir = "/etc/containers/systemd"
        if os.path.exists(system_quadlet_dir):
            for filepath in glob.glob(os.path.join(system_quadlet_dir, "**/*"), recursive=True):
                 if os.path.isfile(filepath):
                    ext = os.path.splitext(filepath)[1]
                    if ext in quadlet_exts:
                         basename = os.path.basename(filepath)
                         service_name = os.path.splitext(basename)[0] + ".service"
                         service_sources[service_name] = ext
                         service_paths[service_name] = filepath
        
        # Map to ServiceUnit
        services = []
        for u in units:
            name = u.get('unit')
            
            clean_name = name
            if clean_name.endswith('.service'):
                clean_name = clean_name[:-8]

            # Special detection (Relaxed to match 'nginx' anywhere often used)
            # We strictly check for standard names but maybe the user has 'nginx-proxy' etc.
            # But the requirement is likely 'nginx'
            clean_lower = clean_name.lower()
            
            # Known proxy software
            known_proxies = ['nginx', 'haproxy', 'traefik', 'caddy', 'envoy']
            is_known_proxy = any(kp in clean_lower for kp in known_proxies)
            
            # Fuzzy check: 'proxy' in name, but exclude known system services like 'mpris-proxy'
            is_fuzzy_proxy = 'proxy' in clean_lower and 'mpris-proxy' not in clean_lower
            
            is_proxy = is_known_proxy or is_fuzzy_proxy
            if clean_name == 'nginx' or clean_name == 'nginx-web': is_proxy = True

            # Robust ServiceBay detection (inc. dev/prod/service)
            is_sb = 'servicebay' in clean_lower
            
            # Managed Detection
            # True if backed by a .kube file
            source_ext = service_sources.get(name)
            is_managed = (source_ext == '.kube')
            
            # Handle Nginx Alias for Managed detection (nginx-web -> nginx.kube)
            if not is_managed and is_proxy:
                 if 'nginx.service' in service_sources and service_sources['nginx.service'] == '.kube':
                      is_managed = True
            
            # Filter: Must be in our valid list OR be a core service we care about
            if name not in service_sources and not is_proxy and not is_sb:
                continue
            
            # --- Link Containers (Strict Mode) ---
            associated_ids = []
            service_ports = []
            if containers:
                for c in containers:
                    # Match Strategy 1: Exact Name Match
                    # (Quadlet default: container name = service name)
                    c_names = [n.lstrip('/') for n in c.get('names', [])]
                    
                    # Match clean_name OR systemd-clean_name (Quadlet Default)
                    is_match = False
                    if clean_name in c_names: is_match = True
                    if not is_match and f"systemd-{clean_name}" in c_names: is_match = True
                    
                    if is_match:
                        associated_ids.append(c['id'])
                        service_ports.extend(c.get('ports', []))
                        # Note: We rely on Frontend/Twin to enrich with these ports if found
                        continue 

                    # Match Strategy 2: Pod Name Match
                    # (Kube Play: pod name = service name)
                    pod_name = c.get('podName', '')
                    if pod_name and pod_name == clean_name:
                         associated_ids.append(c['id'])
                         service_ports.extend(c.get('ports', []))

            
            # --- Result Construction ---

            services.append({
                'name': clean_name,
                'id': clean_name,
                'activeState': u.get('active'),
                'subState': u.get('sub'),
                'loadState': u.get('load'),
                'description': u.get('description'),
                'path': u.get('fragment_path', ''),
                'active': u.get('active') == 'active' or u.get('active') == 'reloading',
                'isReverseProxy': False, # Backend Calculated
                'isServiceBay': False,   # Backend Calculated
                'isManaged': is_managed,
                'associatedContainerIds': associated_ids,
                'ports': [] # Backend Calculated (Static Parsing moved to ServiceManager)
            })
        
        # Sort by Name
        services.sort(key=lambda x: x['name'])
        return services
    except Exception:
        # Fallback for manual parsing or older systemd?
        return []


def fetch_files(extra_dirs=None):
    # Watch ~/.config/containers/systemd and extra (Nginx) dirs
    search_dirs = [os.path.expanduser("~/.config/containers/systemd")]
    if extra_dirs:
        search_dirs.extend(extra_dirs)
        
    files_data = {}
    valid_exts = {'.kube', '.container', '.volume', '.network', '.pod', '.nlink', '.yaml', '.yml', '.conf'}
    
    seen_paths = set()

    for base_dir in search_dirs:
        if not os.path.exists(base_dir):
            continue
            
        # Recursive glob
        # Note: glob might be slow on large trees, but usually config dirs are small
        for filepath in glob.glob(os.path.join(base_dir, "**/*"), recursive=True):
            if os.path.isfile(filepath):
                # Deduplication (in case of overlapping mounts or repeated dirs)
                if filepath in seen_paths: continue
                seen_paths.add(filepath)

                ext = os.path.splitext(filepath)[1]
                if ext not in valid_exts:
                    continue
                    
                try:
                    # Enforce size limit (e.g. 100KB) to prevent choking on large files
                    if os.path.getsize(filepath) > 100 * 1024:
                        continue
                        
                    with open(filepath, 'r') as f:
                        content = f.read()
                    stat = os.stat(filepath)
                    files_data[filepath] = {
                        'path': filepath, # Send absolute path
                        'content': content,
                        'modified': stat.st_mtime
                    }
                except:
                    pass
    return files_data

def get_sys_uptime_seconds():
    try:
        with open('/proc/uptime', 'r') as f:
            return float(f.readline().split()[0])
    except:
        return 0.0

def get_disk_partitions_and_usage():
    """
    Parses 'df -P -k' to get disk usage for all physical mounts.
    """
    disks = []
    try:
        # -P: POSIX portability (single line)
        # -k: 1K blocks
        # -T: Print standard filesystem type
        output = subprocess.check_output(['df', '-P', '-k', '-T'], stderr=subprocess.DEVNULL).decode('utf-8')
        lines = output.strip().splitlines()
        
        # Skip header
        for line in lines[1:]:
            parts = line.split()
            if len(parts) < 7:
                continue
                
            fs_type = parts[1]
            # Handle spaces in mount path
            mount_point = ' '.join(parts[6:])

            # Filter for common physical filesystems
            # We filter OUT things we know are not interesting
            if fs_type in ['tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'iso9660', 'cgroup', 'tracefs', 'cgroup2', 'sysfs', 'proc', 'devpts', 'mqueue', 'hugetlbfs', 'securityfs', 'debugfs', 'pstore', 'autofs', 'fuse.portal', 'fuse.gvfsd-fuse']:
                continue
            
            # Additional filter: exclude docker/containers mounts
            if '/var/lib/containers' in mount_point or '/var/lib/docker' in mount_point:
                continue
            
            # Additional filter: exclude /boot/efi
            if mount_point.startswith('/boot/'):
                 pass 

            try:
                total_k = int(parts[2])
                used_k = int(parts[3])
                
                # Calculate percentage
                percent_str = parts[5].replace('%', '')
                use_pcent = float(percent_str)

                disks.append({
                    'device': parts[0],
                    'mount': mount_point,
                    'fstype': fs_type,
                    'total': total_k * 1024,
                    'used': used_k * 1024,
                    'usePercent': use_pcent
                })
            except ValueError:
                continue
                
    except Exception:
        pass
        
    return disks

def get_cpu_usage():
    try:
        def read_stat():
            with open('/proc/stat', 'r') as f:
                lines = f.readlines()
                for line in lines:
                    if line.startswith('cpu '):
                        parts = line.split()
                        return [int(x) for x in parts[1:]]
            return []
        
        stat1 = read_stat()
        time.sleep(0.1)
        stat2 = read_stat()
        
        if not stat1 or not stat2:
            return 0.0
            
        # user, nice, system, idle, iowait, irq, softirq, steal
        def sum_cpu(stat):
            return sum(stat)
            
        def sum_idle(stat):
            return stat[3] + stat[4] # idle + iowait
            
        total1 = sum_cpu(stat1)
        idle1 = sum_idle(stat1)
        total2 = sum_cpu(stat2)
        idle2 = sum_idle(stat2)
        
        diff_total = total2 - total1
        diff_idle = idle2 - idle1
        
        if diff_total == 0: return 0.0
        
        usage = ((diff_total - diff_idle) / diff_total) * 100
        return round(usage, 1)
    except:
        return 0.0

def get_cpu_info():
    info = {'model': 'Unknown', 'cores': 1}
    try:
        with open('/proc/cpuinfo', 'r') as f:
            lines = f.readlines()
            
        processors = [l for l in lines if l.startswith('processor')]
        if processors:
            info['cores'] = len(processors)
        
        for line in lines:
            if line.startswith('model name'):
                info['model'] = line.split(':', 1)[1].strip()
                break
    except:
        pass
    return info

def get_network_interfaces():
    try:
        # Use ip -j addr to get JSON output of network interfaces
        # This is standard on modern linux distributions with iproute2
        output = subprocess.check_output(['ip', '-j', 'addr'], stderr=subprocess.DEVNULL).decode('utf-8')
        networking_data = json.loads(output)
        
        interfaces = {}
        for iface in networking_data:
            name = iface.get('ifname')
            # Skip loopback
            if not name or name == 'lo':
                continue
            
            # Skip down interfaces if desired? keep them for now.
            
            addr_infos = iface.get('addr_info', [])
            if not addr_infos:
                continue

            addrs = []
            for addr in addr_infos:
                family_str = addr.get('family') # inet or inet6
                local_ip = addr.get('local')
                scope = addr.get('scope') # e.g. global, link, host

                if local_ip:
                     addrs.append({
                         'address': local_ip,
                         'family': 'IPv6' if family_str == 'inet6' else 'IPv4',
                         'internal': scope != 'global'
                     })
            
            if addrs:
                interfaces[name] = addrs
        
        return interfaces
    except Exception:
        return {}

def get_sys_resources():
    # 1. Memory
    res_mem_total = 0
    res_mem_used = 0
    try:
        mem_info = {}
        with open('/proc/meminfo', 'r') as f:
            for line in f:
                parts = line.split(':')
                if len(parts) == 2:
                    k = parts[0].strip()
                    v = int(parts[1].strip().split()[0]) * 1024 # KB to Bytes
                    mem_info[k] = v
        
        if 'MemTotal' in mem_info:
            res_mem_total = mem_info['MemTotal']
            available = mem_info.get('MemAvailable', 0)
            res_mem_used = res_mem_total - available
    except:
        pass
        
    # 2. Disk (Root) - Legacy, keeping for compatibility
    res_disk_usage = 0.0
    try:
        st = os.statvfs('/')
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        used = total - free
        if total > 0:
            res_disk_usage = round((used / total) * 100, 1)
    except:
        pass
        
    # 3. CPU
    res_cpu_usage = get_cpu_usage()
    res_cpu_info = get_cpu_info()

    # 4. OS Static Info
    os_info = {
        'hostname': socket.gethostname(),
        'platform': platform.platform(),
        'release': platform.release(),
        'arch': platform.machine(),
        'uptime': get_sys_uptime_seconds()
    }

    # 5. Full Disks
    disks = get_disk_partitions_and_usage()
    
    # 6. Network
    network_info = get_network_interfaces()
    
    # Use dataclass and return dict
    return asdict(SystemResources(
        cpuUsage=res_cpu_usage,
        memoryUsage=res_mem_used,
        totalMemory=res_mem_total,
        diskUsage=res_disk_usage,
        os=os_info,
        disks=disks,
        network=network_info,
        cpu=res_cpu_info
    ))

# --- Proxy Inspector ---

INSPECTOR_SCRIPT = r"""
#!/bin/sh
# Nginx Inspector Script v2
# Outputs JSON array of {host, targetService, targetPort, ssl}
echo "["
FIRST=1
# Broaden search paths
SEARCH_PATHS="/etc/nginx/conf.d/*.conf /data/nginx/proxy_host/*.conf /etc/nginx/sites-enabled/* /config/nginx/proxy-confs/*.subdomain.conf"

for file in $SEARCH_PATHS; do
    [ -e "$file" ] || continue
    if [ -d "$file" ]; then continue; fi
    
    SERVER_NAME=$(grep -m1 "server_name" "$file" | awk '{print $2}' | sed 's/;//' | head -n 1)
    
    NPM_SERVER=$(grep "set \$server" "$file" | awk '{print $3}' | sed 's/"//g' | sed 's/;//' | head -n 1)
    NPM_PORT=$(grep "set \$port" "$file" | awk '{print $3}' | sed 's/"//g' | sed 's/;//' | head -n 1)
    
    if [ ! -z "$NPM_SERVER" ] && [ ! -z "$NPM_PORT" ]; then
        PROXY_PASS="$NPM_SERVER:$NPM_PORT"
    else
        PROXY_PASS=$(grep "proxy_pass" "$file" | grep -v '^\s*#' | head -n 1 | awk '{print $2}' | sed 's/;//' | sed 's/http:\/\///' | sed 's/https:\/\///')
    fi
    
    if [ ! -z "$SERVER_NAME" ] && [ ! -z "$PROXY_PASS" ]; then
        if [ "$FIRST" -eq 0 ]; then echo ","; fi
        TARGET=$(echo "$PROXY_PASS" | sed 's/\/$//')
        
        # Extract Port
        PORT=80
        if echo "$TARGET" | grep -q ":"; then
             PORT=$(echo "$TARGET" | awk -F: '{print $NF}' | sed 's/[^0-9]*//g')
        fi
        [ -z "$PORT" ] && PORT=80
        
        LISTEN_SSL=$(grep -q "listen 443" "$file" && echo "true" || echo "false")

        echo "  {"
        echo "    \"host\": \"$SERVER_NAME\","
        echo "    \"targetService\": \"$TARGET\","
        echo "    \"targetPort\": $PORT," 
        echo "    \"ssl\": $LISTEN_SSL"
        echo "  }"
        FIRST=0
    fi
done
echo "]"
"""

def fetch_proxy_routes():
    # 1. Search for Nginx Container (Label priority, then Names)
    container_name = None

    # Try Label First
    cmd = ['podman', 'ps', '--filter', 'label=servicebay.role=reverse-proxy', '--format', '{{.Names}}']
    output = run_command(cmd)
    if output:
        container_name = output.splitlines()[0]

    # Try Candidates
    if not container_name:
        candidates = ['nginx-web', 'nginx', 'nginx-reverse-proxy', 'proxy']
        for c in candidates:
            cmd = ['podman', 'ps', '--filter', f'name={c}', '--format', '{{.Names}}']
            output = run_command(cmd)
            if output:
                container_name = output.splitlines()[0]
                break

    if not container_name:
        return []

    # sys.stderr.write(f"[Agent] Found Nginx container: {container_name}\n")
    # sys.stderr.flush()

    # 2. Exec inspector script
    # We pass the script via stdin to sh
    try:
        result = subprocess.run(
            ['podman', 'exec', '-i', container_name, 'sh'],
            input=INSPECTOR_SCRIPT,
            capture_output=True,
            text=True,
            timeout=5
        )

        if result.stderr:
             sys.stderr.write(f"[Agent] Nginx Inspector Stderr: {result.stderr}\n")

        if result.returncode == 0:
            routes = json.loads(result.stdout)
            log_debug(f"Parsed Nginx Routes (Container: {container_name}): {json.dumps(routes)}")
            
            # Sort routes for deduplication stability
            # Also ensure all keys are strings to prevent comparison errors if None
            routes.sort(key=lambda x: (str(x.get('host', '')), str(x.get('targetService', ''))))
            return routes
    except Exception as e:
        sys.stderr.write(f"[Agent] Proxy inspector failed: {e}\n")
        # log(f"Proxy inspector failed: {e}")
        pass
        
    return []


# --- Inotify ---

class InotifyWatcher:
    """
    A ctypes-based inotify watcher.
    """
    IN_MODIFY = 0x00000002
    IN_ATTRIB = 0x00000004
    IN_CLOSE_WRITE = 0x00000008
    IN_MOVED_FROM = 0x00000040
    IN_MOVED_TO = 0x00000080
    IN_CREATE = 0x00000100
    IN_DELETE = 0x00000200
    IN_DELETE_SELF = 0x00000400
    IN_MOVE_SELF = 0x00000800
    
    # We care about modifications, creations, deletions, moves
    MASK = IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE | IN_MOVED_FROM | IN_MOVED_TO | IN_CREATE | IN_DELETE | IN_DELETE_SELF | IN_MOVE_SELF

    def __init__(self):
        self.libc = ctypes.CDLL(None)
        # int inotify_init(void);
        try:
            self.libc.inotify_init.argtypes = []
            self.libc.inotify_init.restype = ctypes.c_int
            
            # int inotify_add_watch(int fd, const char *pathname, uint32_t mask);
            self.libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
            self.libc.inotify_add_watch.restype = ctypes.c_int
            
            # int inotify_rm_watch(int fd, int wd);
            self.libc.inotify_rm_watch.argtypes = [ctypes.c_int, ctypes.c_int]
            self.libc.inotify_rm_watch.restype = ctypes.c_int
            
            self.fd = self.libc.inotify_init()
        except Exception:
            self.fd = -1

        if self.fd < 0:
            raise OSError("inotify_init failed")
            
        self.watches = {} # path -> wd
        self.reverse_watches = {} # wd -> path

    def update_watches(self, dirs):
        """
        Updates the set of watched directories.
        Adds new ones, removes old ones. Recurses into subdirs.
        """
        desired = set()
        for d in dirs:
            if os.path.exists(d) and os.path.isdir(d):
                desired.add(os.path.abspath(d))
                # Recurse
                for root, subs, files in os.walk(d):
                    for s in subs:
                        desired.add(os.path.abspath(os.path.join(root, s)))
        
        current = set(self.watches.keys())
        
        to_add = desired - current
        to_remove = current - desired
        
        for d in to_remove:
            wd = self.watches.pop(d)
            self.reverse_watches.pop(wd, None)
            try:
                self.libc.inotify_rm_watch(self.fd, wd)
            except: pass
            
        for d in to_add:
            try:
                wd = self.libc.inotify_add_watch(self.fd, d.encode('utf-8'), self.MASK)
                if wd >= 0:
                    self.watches[d] = wd
                    self.reverse_watches[wd] = d
            except Exception:
                pass

    def wait_for_events(self, timeout=None):
        """
        Waits for events. Returns True if events occurred, False on timeout.
        Timeout is in seconds.
        """
        try:
            r, w, x = select.select([self.fd], [], [], timeout)
            if r:
                # Consume events to empty buffer
                os.read(self.fd, 4096)
                # We don't parse deeply, just knowing change happened is enough to trigger scan
                return True
        except:
            pass
        return False
        
    def close(self):
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1


# --- Aggregator ---

class Agent:
    def __init__(self):
        self.state = {
            'containers': [],
            'services': [],
            'volumes': [],
            'files': {},
            'resources': None,
            'proxy': []
        }
        self.lock = threading.RLock() # Reentrant lock to allow nested calls if needed, also strictly serializes state access
        self.io_lock = threading.Lock() # Strict Output Serialization Lock
        self.last_push = 0
        self.monitoring_enabled = False
        self.last_resources = None
        self.last_resource_push = 0
        self.resource_monitoring_high_freq = False
        
        # Throttling for container scans
        self.scan_scheduled = False
        self.scan_timer = None
        
    def start(self):
        # Start monitors
        self.podman_monitor = PodmanMonitor(self.on_container_event)
        self.podman_monitor.start()
        
        SystemdMonitor(self.on_service_event).start()
        ResourceMonitor(self.on_resource_tick).start()
        
        # File watcher loop
        threading.Thread(target=self.file_watcher_loop, daemon=True).start()
        
        # Initial Full Sync
        self.refresh_all()
        
        try:
             # Main Loop: Listen for stdin commands
            while True:
                try:
                    line = sys.stdin.readline()
                    if not line:
                        break
                    
                    line = line.strip()
                    if not line:
                        continue
                        
                    msg = json.loads(line)
                    self.handle_command(msg)
                except Exception:
                    pass
        finally:
            self.shutdown()

    def shutdown(self):
        log_debug("Agent shutting down...")
        if hasattr(self, 'podman_monitor') and hasattr(self.podman_monitor, 'proc'):
            try:
                log_debug("Terminating podman events process...")
                self.podman_monitor.proc.terminate()
                self.podman_monitor.proc.wait(timeout=1)
            except Exception:
                pass
    
    def handle_command(self, msg):
        cmd = msg.get('action')
        req_id = msg.get('id')
        
        sys.stderr.write(f"[Agent] Received command: {cmd} (ID: {req_id})\n")
        sys.stderr.flush()

        # Fallback response helper
        def reply(result=None, error=None):
            resp = {
                'type': 'response',
                'payload': {
                    'id': req_id,
                    'result': result,
                    'error': error
                }
            }
            with self.io_lock:
                sys.stdout.write(json.dumps(resp) + "\0")
                sys.stdout.flush()

        try:
            if cmd == 'ping':
                reply(result='pong')
            elif cmd == 'listServices':
                # Legacy support: return services list immediately
                with self.lock:
                    reply(result={'services': self.state['services']}) # Legacy might expect wrapper
            elif cmd == 'listContainers':
                with self.lock:
                    reply(result=self.state['containers'])
            elif cmd == 'refresh':
                self.refresh_all()
            elif cmd == 'setResourceMode':
                payload = msg.get('payload', {})
                active = payload.get('active', False)
                with self.lock:
                    self.resource_monitoring_high_freq = active
                    # Force immediate push if activating to update UI instantly
                    if active:
                        self.last_resource_push = 0
                reply(result='ok')
            elif cmd == 'exec':
                command_str = msg.get('payload', {}).get('command')
                if not command_str:
                    reply(error="Missing command")
                else:
                    # execute
                    proc = subprocess.run(command_str, shell=True, capture_output=True, text=True)
                    reply(result={
                        "code": proc.returncode,
                        "stdout": proc.stdout,
                        "stderr": proc.stderr
                    })
            elif cmd == 'write_file':
                path = msg.get('payload', {}).get('path')
                content = msg.get('payload', {}).get('content')
                if not path or content is None:
                    reply(error="Missing path or content")
                else:
                    try:
                        expanded_path = os.path.expanduser(path)
                        os.makedirs(os.path.dirname(expanded_path), exist_ok=True)
                        with open(expanded_path, 'w') as f:
                            f.write(content)
                        reply(result="ok")
                    except Exception as e:
                        reply(error=str(e))
            elif cmd == 'read_file':
                path = msg.get('payload', {}).get('path')
                if not path:
                    reply(error="Missing path")
                else:
                    try:
                        expanded_path = os.path.expanduser(path)
                        if not os.path.exists(expanded_path):
                             reply(error=f"File not found: {path}")
                        else:
                             with open(expanded_path, 'r') as f:
                                 content = f.read()
                             reply(result={'content': content})
                    except Exception as e:
                        reply(error=str(e))
            elif cmd == 'startMonitoring':
                with self.lock:

                    self.monitoring_enabled = True
                    # Force immediate update
                    threading.Thread(target=self.on_resource_tick, args=(True,)).start()
                reply(result='ok')
            elif cmd == 'stopMonitoring':
                with self.lock:
                    self.monitoring_enabled = False
                reply(result='ok')
            else:
                reply(error=f"Unknown command: {cmd}")
        except Exception as e:
            reply(error=str(e))

    def file_watcher_loop(self):
        # Initialize Inotify
        watcher = None
        try:
            watcher = InotifyWatcher()
            log_debug("Inotify Watcher Initialized")
        except Exception as e:
             sys.stderr.write(f"WARNING: Inotify init failed ({e}). Falling back to polling.\n")
             pass

        while True:
            # 1. Update Watches & Wait
            extra_dirs = []
            with self.lock:
                if self.state['containers']:
                    extra_dirs = self._get_nginx_config_dirs(self.state['containers'])
            
            # Use both default config dir and extra dirs
            base_config = os.path.expanduser("~/.config/containers/systemd")
            # Ensure base dir exists for watching
            if not os.path.exists(base_config):
                try: os.makedirs(base_config, exist_ok=True)
                except: pass

            dirs_to_watch = [base_config] + extra_dirs

            if watcher:
                watcher.update_watches(dirs_to_watch)
                
                # Wait for events with timeout (re-check dirs period 3s)
                has_events = watcher.wait_for_events(timeout=3.0)
                
                if not has_events:
                     continue
                
                # Debounce
                time.sleep(0.5)
                watcher.wait_for_events(timeout=0.1)
                
            else:
                # Polling Fallback
                time.sleep(2)

            # 2. Fetch files (expensive IO)
            new_files = fetch_files(extra_dirs)
            
            # 3. Compare State
            changes_pushed = False
            with self.lock:
                # Check for changes
                changed = False
                current_keys = set(self.state['files'].keys())
                new_keys = set(new_files.keys())
                
                if current_keys != new_keys:
                    changed = True
                    log_debug(f"File Watcher: File list changed (Old: {len(current_keys)}, New: {len(new_keys)})")
                else:
                    for k, v in new_files.items():
                        if k in self.state['files']: 
                            if self.state['files'][k]['modified'] != v['modified']:
                                changed = True
                                log_debug(f"File Watcher: File modified: {k}")
                                break
                        else:
                            changed = True; break
                
                if changed:
                    self._process_file_changes(new_files)
                    changes_pushed = True
            
            # 4. Backoff
            if changes_pushed:
                time.sleep(2)

    def _process_file_changes(self, new_files):
        """
        Internal method to handle state updates when files change.
        Separated for testing purposes.
        """
        # Always update and push files since we know they changed
        self.state['files'] = new_files
        self.push_state('SYNC_PARTIAL', {'files': self.state['files']})
        
        # Check Services
        new_services = fetch_services()
        if new_services != self.state.get('services'):
            self.state['services'] = new_services
            self.push_state('SYNC_PARTIAL', {'services': self.state['services']})
            log_debug("File change triggered services update")
        
        # Check Proxy
        new_proxy = fetch_proxy_routes()
        if new_proxy != self.state.get('proxy'):
            self.state['proxy'] = new_proxy
            self.push_state('SYNC_PARTIAL', {'proxy': self.state['proxy']})
            log_debug("File change triggered proxy update")

    def refresh_all(self):
        with self.lock:
            # 1. Fetch all data
            self.state['containers'] = fetch_containers()
            
            # Identify Nginx Mounts for fetch_files
            extra_dirs = self._get_nginx_config_dirs(self.state['containers'])
            
            self.state['services'] = fetch_services(self.state['containers'])
            self.state['volumes'] = fetch_volumes(self.state['containers']) 
            self.state['files'] = fetch_files(extra_dirs)
            self.state['resources'] = get_sys_resources()
            self.state['proxy'] = fetch_proxy_routes()
            
            # 2. Push Granular Updates (SYNC_PARTIAL)
            # This avoids huge 32KB+ payloads that might choke the channel
            self.push_state('SYNC_PARTIAL', {'containers': self.state['containers']})
            self.push_state('SYNC_PARTIAL', {'services': self.state['services']})
            self.push_state('SYNC_PARTIAL', {'volumes': self.state['volumes']})
            self.push_state('SYNC_PARTIAL', {'files': self.state['files']})
            self.push_state('SYNC_PARTIAL', {'proxy': self.state['proxy']})
            self.push_state('SYNC_PARTIAL', {'resources': self.state['resources']})
            
            # 3. Signal Complete (sets initialSyncComplete on receiver)
            self.push_state('SYNC_PARTIAL', {'initialSyncComplete': True})

    def _get_nginx_config_dirs(self, containers):
        # Auto-detect Nginx config bind mounts
        host_dirs = []
        for c in containers:
            # Identify Nginx
            is_proxy = False
            # Labels
            labels = c.get('labels', {})
            if labels.get('servicebay.role') == 'reverse-proxy': is_proxy = True
            
            # Names
            names = c.get('names', [])
            for n in names:
                if 'nginx' in n.lower() or 'proxy' in n.lower(): is_proxy = True
            
            if is_proxy:
                mounts = c.get('mounts', [])
                if isinstance(mounts, list):
                    for m in mounts:
                        # Defensive check: ensure m is a dict
                        if not isinstance(m, dict):
                            continue
                            
                        # Detect bind mounts acting as config dirs
                        if m.get('Type') == 'bind' or m.get('type') == 'bind':
                            src = m.get('Source') or m.get('source')
                            dst = m.get('Destination') or m.get('destination')
                            
                            if src and dst and os.path.isdir(src):
                                # Common Nginx config paths
                                if dst.startswith('/etc/nginx') or dst.startswith('/config') or dst.startswith('/data/nginx'):
                                    host_dirs.append(src)
        return list(set(host_dirs))

    def on_container_event(self, _type):
        """
        Schedules a container scan with debouncing.
        If multiple events arrive in quick succession, we only scan once after the settling time.
        """
        with self.lock:
            if self.scan_scheduled:
                return
            
            self.scan_scheduled = True
            # debounce for 1 second
            self.scan_timer = threading.Timer(1.0, self._perform_delayed_scan)
            self.scan_timer.daemon = True # Ensure timer doesn't block exit
            self.scan_timer.start()

    def _perform_delayed_scan(self):
        with self.lock:
            self.scan_scheduled = False
            
            log_debug("Performing debounced container scan...")
            
            # Fetch new state
            new_containers = fetch_containers()
            new_volumes = fetch_volumes(new_containers) 
            new_services = fetch_services(new_containers) 
            new_proxy = fetch_proxy_routes()
            
            # Deduplication: Only update and push if changed
            updates = {}
            
            if new_containers != self.state['containers']:
                self.state['containers'] = new_containers
                updates['containers'] = new_containers
                
            if new_volumes != self.state['volumes']:
                self.state['volumes'] = new_volumes
                updates['volumes'] = new_volumes
                
            if new_services != self.state['services']:
                self.state['services'] = new_services
                updates['services'] = new_services
                
            if new_proxy != self.state['proxy']:
                self.state['proxy'] = new_proxy
                updates['proxy'] = new_proxy
            
            if updates:
                log_debug(f"Pushing updates for: {list(updates.keys())}")
                for key, val in updates.items():
                    self.push_state('SYNC_PARTIAL', {key: val})
            else:
                log_debug("Scan complete. No changes detected.")

    def on_service_event(self, _type):
        with self.lock:
            new_services = fetch_services(self.state['containers'])
            
            # Only push if changed
            if new_services != self.state['services']:
                self.state['services'] = new_services
                self.push_state('SYNC_PARTIAL', {'services': self.state['services']}) # Push full list for now (diffing handled by twin store)

    def on_resource_tick(self, force=False):
        # 1. Check if enabled
        if not self.monitoring_enabled and not force:
            return

        with self.lock:
            now = time.time()
            # 2. Throttling (dynamic interval based on active viewers)
            interval = 5 if self.resource_monitoring_high_freq else 60
            if not force and (now - self.last_resource_push < interval):
                return

            new_resources = get_sys_resources()
            
            # 3. Change Detection
            # We compare essential fields (cpu, memory, disk)
            # We skip 'os' and 'network' for diff check usually as they are static or noisy
            # But get_sys_resources returns dict/dataclass?
            # It returns SystemResources object (dataclass) or dict?
            # Check implementation of get_sys_resources... returns dict from previous snippet?
            # Wait, get_sys_resources was reading /proc/meminfo etc. It returned a dict implicitly?
            # Let's check get_sys_resources return (I read it partially).
            # It returns a dict constructed at the end. I need to ensure comparison works.
            
            # Simplified diff: if new != old
            # Note: CPU is float, might always vary slightly.
            has_changed = False
            if self.last_resources is None:
                has_changed = True
            else:
                # Compare basic metrics
                # Depending on sensitivity requirements.
                # User said: "only if the % has changed to the last observed one"
                # so strict inequality is fine.
                if new_resources['cpuUsage'] != self.last_resources['cpuUsage']: has_changed = True
                elif new_resources['memoryUsage'] != self.last_resources['memoryUsage']: has_changed = True
                elif new_resources['diskUsage'] != self.last_resources['diskUsage']: has_changed = True
            
            if has_changed or force:
                self.state['resources'] = new_resources
                self.last_resources = new_resources
                self.last_resource_push = now
                self.push_state('SYNC_PARTIAL', {'resources': self.state['resources']})

    def push_state(self, msg_type, payload=None):
        with self.lock:
             # Lock is held by caller
             pass

        # If payload provided, use it. Otherwise use full state (legacy behavior, but we avoid calling it without payload now)
        out_payload = payload if payload is not None else self.state
        
        # Construct message
        msg = {
            'type': msg_type,
            'payload': out_payload, 
            'timestamp': time.time() * 1000
        }
        
        # Use single write call to atomicize (as much as possible)
        # Use dedicated IO lock to prevent interleaving from different threads 
        # (even if they release state lock early or are responding to commands)
        with self.io_lock:
            try:
                sys.stdout.write(json.dumps(msg) + "\0")
                sys.stdout.flush()
            except Exception as e:
                pass # Broken pipe?

if __name__ == "__main__":
    # Immediate startup signal for debugging
    sys.stderr.write(f"[Agent] Process started (PID: {os.getpid()})\n")
    sys.stderr.flush()

    try:
        if len(sys.argv) > 1 and sys.argv[1] == '--once':
            # Single run mode for testing/debugging
            agent = Agent()
            # Manually trigger one fetch
            agent.refresh_all()
            # No loop
        else:
            agent = Agent()
            agent.start()
    except Exception as e:
        import traceback
        sys.stderr.write(f"CRITICAL AGENT CRASH:\n{traceback.format_exc()}\n")
        sys.stderr.flush()
        sys.exit(1)
