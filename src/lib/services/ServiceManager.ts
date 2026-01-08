import { agentManager } from '../agent/manager';
import path from 'path';
import yaml from 'js-yaml'; 

export interface ServiceInfo {
  name: string;
  kubeFile: string;
  kubePath: string;
  yamlFile: string | null;
  yamlPath: string | null;
  active: boolean;
  status: string;
  description?: string;
  ports: { host?: string; container: string }[];
  volumes: { host: string; container: string }[];
  labels: Record<string, string>;
  hostNetwork?: boolean;
  node?: string;
  id?: string;
  isReverseProxy?: boolean;
  isServiceBay?: boolean;
}

export class ServiceManager {
    static async listServices(nodeName: string): Promise<ServiceInfo[]> {
        const agent = await agentManager.ensureAgent(nodeName);
        
        // Use relative path with HOME fallback for flexibility
        const systemdDir = '.config/containers/systemd';
        
        // Optimized batch fetch script
        const script = `
        target_dir="${systemdDir}"
        # Try cd to target, or relative to HOME
        if cd "$target_dir" 2>/dev/null; then
            echo "DEBUG: Changed dir to $target_dir from PWD"
        elif cd "$HOME/$target_dir" 2>/dev/null; then
            echo "DEBUG: Changed dir to HOME/$target_dir"
        else
            echo "DEBUG: Failed to change dir to $target_dir or $HOME/$target_dir. PWD=$(pwd) HOME=$HOME"
            # Fail silently? Or echo empty? 
            # If the directory doesn't exist, we just have no services.
            exit 0
        fi
        
        # Pre-flight check for systemd accessibility
        if ! systemctl --user list-units --no-pager -n 0 >/dev/null 2>&1; then
            echo "ERROR_SYSTEMD_ACCESS_FAILED"
            exit 1
        fi

        echo "DEBUG: CWD IS $(pwd)"


        # Loop over both .kube and .container files
        # POSIX compliant loop - if no files match, the pattern is passed as literal
        # The [ -e "$f" ] check handles this.
        
        has_files=0
        for f in *.kube *.container; do
            if [ -e "$f" ]; then
                has_files=1
                break
            fi
        done
        
        if [ "$has_files" -eq 0 ]; then
            exit 0
        fi

        for f in *.kube *.container; do
            [ -e "$f" ] || continue
            
            # Determine Name and Type based on extension
            case "$f" in
                *.kube)
                    name="\${f%.kube}"
                    type="kube"
                    ;;
                *.container)
                    name="\${f%.container}"
                    type="container"
                    ;;
                *)
                    name="$f"
                    type="other"
                    ;;
            esac

            echo "---SERVICE_START---"
            echo "NAME: $name"
            echo "TYPE: $type"
            echo "FILE: $f"
            
            svc_status=$(systemctl --user is-active "$name.service" 2>&1)
            exit_code=$?
            
            if [ $exit_code -ne 0 ]; then
                if [ -z "$svc_status" ]; then
                    svc_status="inactive (uid: $(id -u))"
                else
                    # POSIX string matching
                    case "$svc_status" in
                        *"Failed to"*|*"No such"*)
                            svc_status="ERROR: $svc_status"
                            ;;
                    esac
                fi
            fi
            echo "STATUS: $svc_status"

            desc=$(systemctl --user show -p Description --value "$name.service" 2>/dev/null)
            echo "DESCRIPTION: $desc"
            
            echo "CONTENT_START"
            cat "$f"
            echo "CONTENT_END"
            
            if [ "$type" = "kube" ]; then
                # Extract Yaml=... value
                yaml_file=$(grep "^Yaml=" "$f" | head -n1 | cut -d= -f2- | sed 's/^[ \t]*//;s/[ \t]*$//')
                if [ -n "$yaml_file" ]; then
                    echo "YAML_CONTENT_START"
                    # Handle absolute vs relative path for the yaml file
                    if [ -f "$yaml_file" ]; then
                        cat "$yaml_file" 2>/dev/null
                    elif [ -f "$HOME/$target_dir/$yaml_file" ]; then
                        # Try relative to systemd dir (which we are in)
                        cat "$yaml_file" 2>/dev/null
                    fi
                    echo "YAML_CONTENT_END"
                fi
            fi
            echo "---SERVICE_END---"
        done
        `;

        let stdout = '';
        try {
            const res = await agent.sendCommand('exec', { command: script });
            if (res.code !== 0) {
                 const err = new Error(`Service list failed: ${res.stderr}`);
                 // eslint-disable-next-line @typescript-eslint/no-explicit-any
                 (err as any).code = res.code;
                 // eslint-disable-next-line @typescript-eslint/no-explicit-any
                 (err as any).stdout = res.stdout;
                 throw err;
            }
            stdout = res.stdout;
            
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            console.error(`[ServiceManager:${nodeName}] Failed to list services`, e);
             if (e.stdout && e.stdout.includes('ERROR_SYSTEMD_ACCESS_FAILED')) {
                throw new Error('Systemd User Session inaccessible. Check DBUS/XDG environment.');
            }
            throw e;
        }

        return this.parseServiceOutput(stdout, nodeName, systemdDir);
    }

    private static parseServiceOutput(stdout: string, nodeName: string, systemdDir: string): ServiceInfo[] {
      const services: ServiceInfo[] = [];
      const blocks = stdout.split('---SERVICE_START---').filter(b => b.trim());

      for (const block of blocks) {
          try {
             services.push(this.parseBlock(block, nodeName, systemdDir));
          } catch (e) {
              console.error(`Error parsing service block for node ${nodeName}:`, e);
          }
      }
      return services;
    }

    private static parseBlock(block: string, nodeName: string, systemdDir: string): ServiceInfo {
      const lines = block.split('\n');
      const getVal = (prefix: string) => {
          const line = lines.find(l => l.startsWith(prefix));
          return line ? line.substring(prefix.length).trim() : '';
      };

      let name = getVal('NAME: ');
      name = name.replace(/\.(kube|container|service|pod)$/, '');
      // const type = getVal('TYPE: ') || 'kube';
      const fileName = getVal('FILE: ') || `${name}.kube`;
      const status = getVal('STATUS: ') || 'unknown';
      let description = getVal('DESCRIPTION: ');
      const active = status === 'active';

      // Extract Contents
      const extract = (startMarker: string, endMarker: string) => {
          const s = block.indexOf(startMarker);
          const e = block.indexOf(endMarker);
          if (s !== -1 && e !== -1) return block.substring(s + startMarker.length, e).trim();
          return '';
      };

      const content = extract('CONTENT_START', 'CONTENT_END');
      const yamlContent = extract('YAML_CONTENT_START', 'YAML_CONTENT_END');

      // Description Fallback
      if (!description && content) {
          const match = content.match(/Description=(.+)/);
          if (match) description = match[1].trim();
      }

      // Paths
      const kubePath = path.join(systemdDir, fileName); 
      const yamlMatch = content.match(/Yaml=(.+)/);
      const yamlFile = yamlMatch ? yamlMatch[1].trim() : null;
      const yamlPath = yamlFile ? (yamlFile.startsWith('/') ? yamlFile : path.join(systemdDir, yamlFile)) : null;

      // Metadata extraction
      const ports: { host?: string; container: string }[] = [];
      const volumes: { host: string; container: string }[] = [];
      const labels: Record<string, string> = {};
      let hostNetwork = false;
      let isReverseProxy = false;
      let isServiceBay = false;

      // Basic Identification
      if (name === 'nginx' || name === 'nginx-web') isReverseProxy = true;
      if (name.toLowerCase() === 'servicebay') isServiceBay = true;

      // Parsing Logic (YAML or Quadlet)
      if (yamlContent) {
          this.parseYaml(yamlContent, labels, ports, volumes);
          if (labels['servicebay.role'] === 'reverse-proxy') isReverseProxy = true;
          if (labels['servicebay.protected'] === 'true') isServiceBay = true;
          if (yamlContent.includes('hostNetwork: true')) hostNetwork = true; 
      } else if (content) {
          this.parseQuadlet(content, labels, ports);
          if (labels['servicebay.role'] === 'reverse-proxy') isReverseProxy = true;
          if (labels['servicebay.protected'] === 'true') isServiceBay = true;
          if (content.match(/Network=host/)) hostNetwork = true;
      }

      return {
          id: name,
          name,
          kubeFile: fileName,
          kubePath,
          yamlFile,
          yamlPath,
          active,
          status,
          description,
          ports,
          volumes,
          labels,
          hostNetwork,
          isReverseProxy,
          isServiceBay,
          node: nodeName
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static parseYaml(content: string, labels: any, ports: any[], volumes: any[]) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const documents = yaml.loadAll(content) as any[];
            documents.forEach((parsed) => {
                if (parsed) {
                    if (parsed.metadata && parsed.metadata.labels) {
                        Object.assign(labels, parsed.metadata.labels);
                    }
                    if (parsed.spec) {
                        if (parsed.spec.containers) {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            parsed.spec.containers.forEach((container: any) => {
                                if (container.ports) {
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    container.ports.forEach((port: any) => {
                                        if (port.hostPort) {
                                            ports.push({ host: String(port.hostPort), container: String(port.containerPort) });
                                        } else {
                                            ports.push({ container: String(port.containerPort) });
                                        }
                                    });
                                }
                            });
                        }
                        
                        // Extract Volumes
                        if (parsed.spec.volumes && parsed.spec.containers) {
                            const volumeMap = new Map<string, string>();
                            
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            parsed.spec.volumes.forEach((vol: any) => {
                                if (vol.hostPath && vol.hostPath.path) {
                                    volumeMap.set(vol.name, vol.hostPath.path);
                                } else if (vol.persistentVolumeClaim) {
                                    volumeMap.set(vol.name, `PVC:\${vol.persistentVolumeClaim.claimName}`);
                                }
                            });

                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            parsed.spec.containers.forEach((container: any) => {
                                if (container.volumeMounts) {
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    container.volumeMounts.forEach((mount: any) => {
                                        const source = volumeMap.get(mount.name);
                                        if (source) {
                                            volumes.push({ host: source, container: mount.mountPath });
                                        }
                                    });
                                }
                            });
                        }
                    }
                }
            });
        } catch (e) {
            console.warn('YAML Parse Error', e);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static parseQuadlet(content: string, labels: any, ports: any[]) {
        // Parse PublishPort
        const portMatches = content.matchAll(/PublishPort=(.+)/g);
        for (const match of portMatches) {
            const val = match[1].trim();
            const parts = val.split(':');
            if (parts.length === 3) {
                    ports.push({ host: parts[1], container: parts[2] });
            } else if (parts.length === 2) {
                    ports.push({ host: parts[0], container: parts[1] });
            } else {
                    ports.push({ container: val });
            }
        }

        // Parse Labels
        const labelMatches = content.matchAll(/Label=(.+)/g);
        for (const match of labelMatches) {
                const val = match[1].trim();
                const firstEq = val.indexOf('=');
                if (firstEq !== -1) {
                    const k = val.substring(0, firstEq);
                    const v = val.substring(firstEq + 1);
                    labels[k] = v;
                }
        }
    }

    static async startService(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: `systemctl --user start ${serviceName}.service` });
        if (res.code !== 0) throw new Error(res.stderr);
    }

    static async stopService(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: `systemctl --user stop ${serviceName}.service` });
        if (res.code !== 0) throw new Error(res.stderr);
    }

    static async restartService(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
         const res = await agent.sendCommand('exec', { command: `systemctl --user restart ${serviceName}.service` });
         if (res.code !== 0) throw new Error(res.stderr);
    }

    static async reloadDaemon(nodeName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: 'systemctl --user daemon-reload' });
        if (res.code !== 0) throw new Error(res.stderr);
    }

    static async writeFile(nodeName: string, filename: string, content: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const targetPath = `~/.config/containers/systemd/${filename}`;
        const res = await agent.sendCommand('write_file', { path: targetPath, content });
        if (res !== "ok") throw new Error('Failed to write ' + filename);
    }

    static async deployKubeService(nodeName: string, name: string, kubeContent: string, yamlContent: string, yamlName: string) {
        await this.writeFile(nodeName, yamlName, yamlContent);
        await this.writeFile(nodeName, `${name}.kube`, kubeContent);
        await this.reloadDaemon(nodeName);
        // Attempt start, but don't fail deployment if start fails (user can check logs)
        try {
             await this.startService(nodeName, name);
        } catch(e) {
             console.warn(`[ServiceManager] Service ${name} deployed but start failed:`, e);
        }
    }

    static async deployService(nodeName: string, filename: string, content: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const targetPath = `~/.config/containers/systemd/${filename}`;
        
        // agent.py "write_file" returns "ok"
        const res = await agent.sendCommand('write_file', { path: targetPath, content });
        if (res !== "ok") {
             throw new Error('Failed to write service file');
        }
        
        await this.reloadDaemon(nodeName);
    }
    
    static async removeService(nodeName: string, filename: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        // Use variable to avoid quoting issues
        const cmd = `
        f="$HOME/.config/containers/systemd/${filename}"
        if [ -f "$f" ]; then rm -f "$f"; fi
        `;
        const res = await agent.sendCommand('exec', { command: cmd });
         if (res.code !== 0) throw new Error(res.stderr);
         
        await this.reloadDaemon(nodeName);
    }
}
