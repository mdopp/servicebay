'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { type HumanizedYamlError } from '@servicebay/api-client';
import { typedFetch, ValidateYamlResponseSchema } from '@servicebay/api-client';
import { Settings, FileCode, FileJson, FileText, AlertCircle, Network, HardDrive, Pencil, AlertTriangle, Clock, Server, Clipboard, Loader2, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-ini'; // For systemd/kube files (ini-like)
import 'prismjs/themes/prism-tomorrow.css'; // Dark theme for code
import HistoryViewer from './HistoryViewer';
import { getNodes } from '@/app/actions/system';
import { PodmanConnection } from '@servicebay/api-client';
import { useToast } from '@/providers/ToastProvider';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { Button, Input, Select } from '@/components/ui';

interface KubeContainerPort {
    containerPort: number;
    hostPort?: number;
}
interface KubeVolumeMount {
    name: string;
    mountPath: string;
}
interface KubeContainer {
    name: string;
    image: string;
    ports?: KubeContainerPort[];
    volumeMounts?: KubeVolumeMount[];
}
interface KubeVolume {
    name: string;
    hostPath?: { path: string };
    persistentVolumeClaim?: { claimName: string };
}
interface KubeDoc {
    kind?: string;
    metadata?: { name?: string };
    spec?: {
        containers?: KubeContainer[];
        volumes?: KubeVolume[];
    };
}

export type ServiceFormInitialData = {
    name: string;
    kubeContent: string;
    yamlContent: string;
    yamlFileName: string;
    serviceContent?: string;
    kubePath?: string;
    yamlPath?: string;
    servicePath?: string;
};

interface ServiceFormProps {
    initialData?: ServiceFormInitialData;
  isEdit?: boolean;
    defaultNode?: string;
    onClose?: () => void;
    variant?: 'page' | 'embedded';
}

export default function ServiceForm({ initialData, isEdit, defaultNode, onClose, variant = 'page' }: ServiceFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
    const nodeParam = searchParams?.get('node');
    const initialNode = defaultNode ?? (nodeParam || '');
  const { addToast } = useToast();
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
    const [selectedNode, setSelectedNode] = useState(initialNode);
  
  const [name, setName] = useState(initialData?.name || '');
  const [kubeContent, setKubeContent] = useState(initialData?.kubeContent || '');
  const [yamlContent, setYamlContent] = useState(initialData?.yamlContent || '');
  const [yamlFileName, setYamlFileName] = useState(initialData?.yamlFileName || 'pod.yml');
  const [serviceContent] = useState(initialData?.serviceContent || '');
  const [description, setDescription] = useState('');
  const [yamlError, setYamlError] = useState<HumanizedYamlError | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [extractedPorts, setExtractedPorts] = useState<{ host?: string; container: string }[]>([]);
  const [extractedVolumes, setExtractedVolumes] = useState<{ host: string; container: string }[]>([]);
  const [showParserDetails, setShowParserDetails] = useState(false);
  const parserDetailsRef = useRef<HTMLDivElement>(null);
  const [parserDetailsHeight, setParserDetailsHeight] = useState<number | string>(0);

  useEffect(() => {
    const handle = requestAnimationFrame(() => {
      if (showParserDetails) {
        setParserDetailsHeight(parserDetailsRef.current?.scrollHeight ?? 'auto');
      } else {
        setParserDetailsHeight(0);
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [showParserDetails]);

  // Rename Modal State
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [newServiceName, setNewServiceName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'yaml' | 'kube' | 'service' | 'history'>('yaml');

  // Escape closes the rename modal like every other modal in the app
  // (ConfirmModal etc.), but not while a rename request is in flight (#2188).
  useEscapeKey(
    () => setShowRenameModal(false),
    showRenameModal && !isRenaming,
  );

  // Options for generation
  const [autoUpdate, setAutoUpdate] = useState(() => {
    if (initialData?.kubeContent) {
        return initialData.kubeContent.includes('AutoUpdate=registry');
    }
    return true;
  });

  useEffect(() => {
    getNodes().then(setNodes);
  }, []);

  // Initialize Description from KubeContent
  useEffect(() => {
    if (initialData?.kubeContent) {
        const match = initialData.kubeContent.match(/Description=(.+)/);
        if (match) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds editable Description from initialData.kubeContent; controlled-init sync
            setDescription(match[1].trim());
        }
    }
  }, [initialData]);

  // react-simple-code-editor types onSelect/onClick/onKeyUp against its
  // wrapper <div>, but the underlying focus target is the inner textarea.
  // Walk to it via the event-source DOM rather than asserting element
  // types — that lets the three handlers share one signature without
  // `as any` while still pulling selection state off the textarea.
  const updateCursorPosition = (e: React.SyntheticEvent) => {
    const root = e.currentTarget as HTMLElement | null;
    const textarea = root instanceof HTMLTextAreaElement
        ? root
        : root?.querySelector('textarea') ?? null;
    if (textarea) {
        const val = textarea.value.substr(0, textarea.selectionStart);
        const line = val.split('\n').length;
        setCursorLine(line);
    }
  };

  const generateKubeContent = (fileName: string, autoUpd: boolean, desc: string) => {
    return `[Unit]
Description=${desc}

[Kube]
Yaml=${fileName}
${autoUpd ? 'AutoUpdate=registry' : ''}

[Install]
WantedBy=default.target`;
  };

  const extractInfo = (parsed: KubeDoc) => {
    const ports: { host?: string; container: string }[] = [];
    const volumes: { host: string; container: string }[] = [];

    if (parsed && parsed.spec) {
        // Extract Ports
        if (parsed.spec.containers) {
            parsed.spec.containers.forEach((container) => {
                if (container.ports) {
                    container.ports.forEach((port) => {
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
            const volumeMap = new Map<string, string>(); // name -> hostPath
            
            parsed.spec.volumes.forEach((vol) => {
                if (vol.hostPath && vol.hostPath.path) {
                    volumeMap.set(vol.name, vol.hostPath.path);
                } else if (vol.persistentVolumeClaim) {
                        volumeMap.set(vol.name, `PVC:${vol.persistentVolumeClaim.claimName}`);
                }
            });

            parsed.spec.containers.forEach((container) => {
                if (container.volumeMounts) {
                    container.volumeMounts.forEach((mount) => {
                        const hostPath = volumeMap.get(mount.name);
                        if (hostPath) {
                            volumes.push({ host: hostPath, container: mount.mountPath });
                        }
                    });
                }
            });
        }
    }
    setExtractedPorts(ports);
    setExtractedVolumes(volumes);
  };

  const handleCopyYaml = () => {
    navigator.clipboard.writeText(yamlContent);
    addToast('success', 'Copied!', 'Full YAML content copied to clipboard');
  };

  const [rerendering, setRerendering] = useState(false);
  const handleRerender = async () => {
    if (!name) return;
    if (!window.confirm(
      'Re-render this service\'s YAML from its template using the current ' +
      'Settings → Template Variables values? The editor below will be replaced ' +
      'with the new YAML; nothing is saved or restarted until you click Save.',
    )) {
      return;
    }
    setRerendering(true);
    try {
      const res = await fetch(`/api/services/${encodeURIComponent(name)}/reconfigure-preview`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast('error', 'Re-render failed', typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
        return;
      }
      if (typeof data.yamlContent === 'string') {
        handleYamlChange(data.yamlContent);
        addToast('success', 'Re-rendered', 'Review the changes and click Save to apply.');
      }
    } catch (e) {
      addToast('error', 'Re-render failed', e instanceof Error ? e.message : String(e));
    } finally {
      setRerendering(false);
    }
  };

  // Server-side YAML validation. Phase 2 of the FE/BE separation
  // (#759) — the form no longer imports `js-yaml`. Returns the parsed
  // manifest on success and null on parse / transport failure (the
  // error state is set as a side effect so the editor's error UI lights
  // up either way).
  const validateYaml = useCallback(async (content: string): Promise<KubeDoc | null> => {
    try {
      const result = await typedFetch(
        '/api/services/validate-yaml',
        ValidateYamlResponseSchema,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ yaml: content }),
        },
      );
      if (result.ok) {
        const manifest = result.manifest as KubeDoc;
        extractInfo(manifest);
        setYamlError(null);
        return manifest;
      }
      setYamlError(result.error);
      setExtractedPorts([]);
      setExtractedVolumes([]);
      return null;
    } catch (e) {
      setYamlError({
        message: e instanceof Error ? e.message : 'Validation request failed',
        raw: String(e),
      });
      setExtractedPorts([]);
      setExtractedVolumes([]);
      return null;
    }
  }, []);

  const handleYamlChange = (content: string) => {
    setYamlContent(content);
    setYamlError(null);
    void (async () => {
      const parsed = await validateYaml(content);
      if (parsed && !isEdit && parsed.metadata && parsed.metadata.name) {
        const extractedName = parsed.metadata.name;
        if (!name || name === extractedName) {
          setName(extractedName);
          const newFileName = `${extractedName}.yml`;
          setYamlFileName(newFileName);
          setKubeContent(generateKubeContent(newFileName, autoUpdate, description));
        }
      }
    })();
  };

  useEffect(() => {
    if (!initialData?.yamlContent) return;
    let cancelled = false;
    void (async () => {
      const parsed = await validateYaml(initialData.yamlContent);
      if (cancelled || !parsed) return;
      // extractInfo already fired inside validateYaml on the success path;
      // nothing more to do here.
    })();
    return () => { cancelled = true; };
  }, [initialData, validateYaml]);

  useEffect(() => {
    if (name && yamlFileName) {
       if (!isEdit) {
          // eslint-disable-next-line react-hooks/set-state-in-effect -- rebuilds KubeContent from form fields; controlled derive of an editable field
          setKubeContent(generateKubeContent(yamlFileName, autoUpdate, description));
       } else {
          // In edit mode, we try to preserve the existing structure but update our managed fields
          setKubeContent(prev => {
             let newContent = prev;
             
             // Update Yaml filename if present
             if (newContent.includes('Yaml=')) {
                 newContent = newContent.replace(/Yaml=.+/, `Yaml=${yamlFileName}`);
             } else {
                 // Fallback if file is empty or weird
                 return generateKubeContent(yamlFileName, autoUpdate, description);
             }

             // Update AutoUpdate
             const hasAutoUpdate = /AutoUpdate=.+/.test(newContent);
             
             if (autoUpdate) {
                 if (hasAutoUpdate) {
                     newContent = newContent.replace(/AutoUpdate=.+/, 'AutoUpdate=registry');
                 } else {
                     // Insert it after Yaml=
                     newContent = newContent.replace(/(Yaml=.+)/, '$1\nAutoUpdate=registry');
                 }
             } else {
                 if (hasAutoUpdate) {
                     newContent = newContent.replace(/\n?AutoUpdate=.+/, '');
                 }
             }

             // Update Description
             const hasDescription = /Description=.+/.test(newContent);
             const hasUnit = /\[Unit\]/.test(newContent);

             if (description) {
                 if (hasDescription) {
                     newContent = newContent.replace(/Description=.+/, `Description=${description}`);
                 } else if (hasUnit) {
                     newContent = newContent.replace(/\[Unit\]/, `[Unit]\nDescription=${description}`);
                 } else {
                     newContent = `[Unit]\nDescription=${description}\n\n${newContent}`;
                 }
             } else {
                 // If description is empty, maybe remove it? Or keep empty?
                 // Let's remove it if empty
                 if (hasDescription) {
                     newContent = newContent.replace(/\n?Description=.+/, '');
                 }
             }

             return newContent;
          });
       }
    }
  }, [yamlFileName, autoUpdate, isEdit, name, description]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (isSaving) return;
        const query = selectedNode ? `?node=${selectedNode}` : '';
        const url = isEdit ? `/api/services/${name}${query}` : `/api/services${query}`;
        const method = isEdit ? 'PUT' : 'POST';

        setIsSaving(true);
        try {
                const res = await fetch(url, {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, kubeContent, yamlContent, yamlFileName }),
                });
                if (!res.ok) {
                        const data = await res.json().catch(() => ({ error: 'Failed to save service' }));
                        throw new Error(data.error || 'Failed to save service');
                }

                addToast('success', 'Service saved', isEdit ? `${name} updated` : `${name} created`);

                if (variant === 'embedded') {
                        onClose?.();
                        router.refresh();
                } else {
                        router.push('/');
                        router.refresh();
                }
        } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to save service';
                addToast('error', 'Save failed', message);
        } finally {
                setIsSaving(false);
        }
    };

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    setRenameError(null);
    setIsRenaming(true);

    try {
        const query = selectedNode ? `?node=${selectedNode}` : '';
        const res = await fetch(`/api/services/${name}/rename${query}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName: newServiceName }),
        });

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Failed to rename service');
        }

        if (variant === 'embedded') {
            onClose?.();
            router.refresh();
        } else {
            router.push(`/edit/${newServiceName}`);
            router.refresh();
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setRenameError(msg);
        setIsRenaming(false);
        return;
    }

    setIsRenaming(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 w-full">
      
      {/* Rename Modal */}
      {showRenameModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-surface rounded-lg shadow-xl max-w-md w-full p-6 animate-in fade-in zoom-in-95 duration-200 border border-border">
                <h3 className="text-lg font-bold text-foreground mb-4 flex items-center gap-2">
                    <Pencil size={20} /> Rename Service
                </h3>

                <div className="bg-status-warn/10 border border-status-warn/30 rounded-md p-4 mb-4 flex gap-3">
                    <AlertTriangle className="text-status-warn shrink-0" size={24} />
                    <div className="text-sm text-foreground">
                        <p className="font-bold mb-1">Warning: Destructive Action</p>
                        <p>This will:</p>
                        <ul className="list-disc list-inside mt-1 space-y-1">
                            <li>Stop the current service <strong>{name}</strong></li>
                            <li>Rename the YAML file to <strong>{newServiceName || '...'}.yml</strong></li>
                            <li>Rename the .kube file</li>
                            <li>Re-install and start the new service</li>
                        </ul>
                    </div>
                </div>

                <div className="mb-4">
                    <label className="block text-sm font-medium text-foreground mb-1">New Service Name</label>
                    <Input
                        type="text"
                        value={newServiceName}
                        onChange={(e) => setNewServiceName(e.target.value)}
                        className="w-full p-2 border border-border bg-surface-2 text-foreground rounded focus:ring-2 focus:ring-accent focus:border-accent"
                        placeholder="my-new-service"
                        autoFocus
                    />
                </div>

                {renameError && (
                    <div className="mb-4 p-3 bg-status-fail/10 text-status-fail text-sm rounded border border-status-fail/30">
                        {renameError}
                    </div>
                )}

                <div className="flex justify-end gap-3">
                    <Button
                        type="button"
                        onClick={() => setShowRenameModal(false)}
                        variant="secondary"
                        disabled={isRenaming}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        onClick={handleRename}
                        disabled={!newServiceName || isRenaming}
                        variant="primary"
                    >
                        {isRenaming ? 'Renaming...' : 'Rename Service'}
                    </Button>
                </div>
            </div>
        </div>
      )}

      {/* Top Section: Configuration */}
      <div className="bg-surface p-6 rounded-lg border border-border shadow-sm">
          <h3 className="text-xl font-bold text-foreground mb-4 flex items-center gap-2">
              <Settings className="text-text-muted" size={24} /> Configuration
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
                <label className="block text-sm font-bold text-foreground mb-2">Target Node</label>
                <div className="relative">
                    <Select
                        value={selectedNode}
                        onChange={(e) => setSelectedNode(e.target.value)}
                        disabled={isEdit}
                        className="w-full p-3 border border-border bg-surface-2 rounded-md text-foreground focus:ring-2 focus:ring-accent focus:border-accent disabled:bg-surface-muted disabled:text-text-subtle appearance-none"
                    >
                        <option value="" disabled>Select a node</option>
                        {nodes.map(n => (
                            <option key={n.Name} value={n.Name}>{n.Name} ({n.URI})</option>
                        ))}
                    </Select>
                    <Server className="absolute right-3 top-3.5 text-text-muted pointer-events-none" size={16} />
                </div>
            </div>

            <div>
                <label className="block text-sm font-bold text-foreground mb-2">Service Name</label>
                <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isEdit}
                className="w-full p-3 border border-border bg-surface-2 rounded-md text-foreground focus:ring-2 focus:ring-accent focus:border-accent disabled:bg-surface-muted disabled:text-text-subtle"
                required
                />
            </div>

            <div>
                <label className="block text-sm font-bold text-foreground mb-2">Description</label>
                <Input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full p-3 border border-border bg-surface-2 rounded-md text-foreground focus:ring-2 focus:ring-accent focus:border-accent"
                placeholder="Optional description"
                />
            </div>

            <div>
                <label className="block text-sm font-bold text-foreground mb-2">YAML Filename</label>
                <div className="flex gap-2">
                    <Input
                        type="text"
                        value={yamlFileName}
                        onChange={(e) => setYamlFileName(e.target.value)}
                        className="w-full p-3 border border-border bg-surface-2 rounded-md text-foreground focus:ring-2 focus:ring-accent focus:border-accent disabled:bg-surface-muted disabled:text-text-subtle"
                        required
                        disabled={isEdit}
                    />
                    {isEdit && (
                        <Button
                            type="button"
                            onClick={() => {
                                setNewServiceName(name);
                                setShowRenameModal(true);
                            }}
                            variant="secondary"
                            size="md"
                            title="Rename Service & Files"
                        >
                            <Pencil size={18} />
                        </Button>
                    )}
                </div>
            </div>

            <div className="flex items-end pb-3 md:col-span-3">
                <label className="flex items-center gap-3 cursor-pointer">
                    <Input
                        type="checkbox"
                        checked={autoUpdate}
                        onChange={(e) => setAutoUpdate(e.target.checked)}
                        className="w-5 h-5 text-accent rounded border-border bg-surface-2 focus:ring-accent"
                    />
                    <span className="text-base text-foreground font-medium">Enable AutoUpdate (registry)</span>
                </label>
            </div>
          </div>

          {/* Extracted Info */}
          {(extractedPorts.length > 0 || extractedVolumes.length > 0) && (
            <div className="mt-6 pt-6 border-t border-border grid grid-cols-1 md:grid-cols-2 gap-6">
                {extractedPorts.length > 0 && (
                    <div>
                        <h4 className="text-sm font-bold text-text-muted mb-2 flex items-center gap-2">
                            <Network size={16} /> Ports
                        </h4>
                        <div className="flex flex-wrap gap-2">
                            {extractedPorts.map((port, i) => (
                                <div key={i} className="bg-surface-2 border border-border rounded px-2 py-1 text-xs font-mono text-text-muted">
                                    {port.host ? (
                                        <>
                                            <span className="text-accent font-semibold">{port.host}</span>
                                            <span className="text-text-subtle mx-1">→</span>
                                            <span>{port.container}</span>
                                        </>
                                    ) : (
                                        <span>{port.container}</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {extractedVolumes.length > 0 && (
                    <div>
                        <h4 className="text-sm font-bold text-text-muted mb-2 flex items-center gap-2">
                            <HardDrive size={16} /> Volumes
                        </h4>
                        <div className="flex flex-col gap-1">
                            {extractedVolumes.map((vol, i) => (
                                <div key={i} className="text-xs font-mono truncate" title={`${vol.host} → ${vol.container}`}>
                                    <span className="text-status-warn">{vol.host}</span>
                                    <span className="text-text-subtle mx-1">→</span>
                                    <span className="text-status-ok">{vol.container}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
          )}
      </div>

      {/* Editors Tabs */}
      <div className="bg-surface rounded-lg border border-border shadow-sm overflow-hidden">
        <div className="flex border-b border-border bg-surface-muted">
            <Button
                type="button"
                className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'yaml' ? 'bg-surface text-accent border-t-2 border-t-accent' : 'text-text-muted hover:text-text'}`}
                onClick={() => setActiveTab('yaml')}
                variant="ghost"
            >
                <FileCode size={16} /> YAML Definition
            </Button>
            <Button
                type="button"
                className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'kube' ? 'bg-surface text-accent border-t-2 border-t-accent' : 'text-text-muted hover:text-text'}`}
                onClick={() => setActiveTab('kube')}
                variant="ghost"
            >
                <FileJson size={16} /> Generated .kube
            </Button>
            {isEdit && serviceContent && (
                <Button
                    type="button"
                    className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'service' ? 'bg-surface text-accent border-t-2 border-t-accent' : 'text-text-muted hover:text-text'}`}
                    onClick={() => setActiveTab('service')}
                    variant="ghost"
                >
                    <FileText size={16} /> Generated Service Unit
                </Button>
            )}
            {isEdit && (
                <Button
                    type="button"
                    className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'history' ? 'bg-surface text-accent border-t-2 border-t-accent' : 'text-text-muted hover:text-text'}`}
                    onClick={() => setActiveTab('history')}
                    variant="ghost"
                >
                    <Clock size={16} /> History
                </Button>
            )}
        </div>

        <div className="p-0">
            {activeTab === 'yaml' && (
                <div className="flex flex-col lg:flex-row h-[700px]">
                    <div className="flex-1 flex flex-col p-6 min-w-0">
                        {initialData?.yamlPath && (
                            <div className="mb-2 text-sm text-text-muted font-mono bg-surface-2 p-2 rounded border border-border break-all">
                            {initialData.yamlPath}
                            </div>
                        )}
                        <p className="text-base text-text-muted mb-4">
                            Paste your Kubernetes YAML here. We will automatically extract the service name and generate the configuration.
                        </p>

                        <div className="flex-1 border border-border rounded-md overflow-hidden bg-surface-muted relative group">
                            <div className="absolute top-2 right-4 z-10 flex items-center gap-2">
                                {isEdit && (
                                    <Button
                                        onClick={handleRerender}
                                        type="button"
                                        disabled={rerendering}
                                        variant="ghost"
                                        size="sm"
                                        className="p-1.5"
                                        title="Re-render this YAML from its template using the current Settings → Template Variables values"
                                    >
                                        <RefreshCw size={14} className={rerendering ? 'animate-spin' : ''} />
                                    </Button>
                                )}
                                <Button
                                    onClick={handleCopyYaml}
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="p-1.5"
                                    title="Copy All"
                                >
                                    <Clipboard size={14} />
                                </Button>
                                <div className="text-xs text-text-muted font-mono bg-surface-muted/30 px-2 py-1 rounded pointer-events-none">
                                    Line: {cursorLine}
                                </div>
                            </div>
                            <div className="h-full overflow-auto custom-scrollbar">
                                <Editor

                        value={yamlContent}
                        onValueChange={handleYamlChange}
                        highlight={code => Prism.highlight(code, Prism.languages.yaml, 'yaml')}
                        padding={16}
                        style={{
                            fontFamily: '"Fira code", "Fira Mono", monospace',
                            fontSize: 14,
                            minHeight: '100%',
                            color: 'var(--foreground)',
                        }}
                        textareaClassName="focus:outline-none"
                        placeholder="apiVersion: v1&#10;kind: Pod&#10;metadata:&#10;  name: my-service..."
                        onSelect={updateCursorPosition}
                        onClick={updateCursorPosition}
                        onKeyUp={updateCursorPosition}
                        />
                            </div>
                        </div>
                    </div>

                </div>
            )}
            
            {activeTab === 'kube' && (
                <>
                    {initialData?.kubePath && (
                        <div className="mb-2 text-sm text-text-muted font-mono bg-surface-2 p-2 rounded border border-border break-all">
                        {initialData.kubePath}
                        </div>
                    )}
                    <div className="border border-border rounded-md overflow-hidden bg-surface-muted">
                        <Editor
                        value={kubeContent}
                        onValueChange={() => {}}
                        highlight={code => Prism.highlight(code, Prism.languages.ini || Prism.languages.text, 'ini')}
                        padding={16}
                        style={{
                            fontFamily: '"Fira code", "Fira Mono", monospace',
                            fontSize: 14,
                            minHeight: '500px',
                            color: 'var(--foreground)',
                        }}
                        textareaClassName="focus:outline-none cursor-not-allowed"
                        readOnly
                        />
                    </div>
                </>
            )}

            {activeTab === 'service' && isEdit && serviceContent && (
                <>
                    {initialData?.servicePath && (
                        <div className="mb-2 text-sm text-text-muted font-mono bg-surface-2 p-2 rounded border border-border break-all">
                        {initialData.servicePath}
                        </div>
                    )}
                    <div className="border border-border rounded-md overflow-hidden bg-surface-muted">
                        <Editor
                            value={serviceContent}
                            onValueChange={() => {}}
                            highlight={code => Prism.highlight(code, Prism.languages.ini || Prism.languages.text, 'ini')}
                            padding={16}
                            style={{
                            fontFamily: '"Fira code", "Fira Mono", monospace',
                            fontSize: 14,
                            minHeight: '500px',
                            color: 'var(--foreground)',
                            }}
                            textareaClassName="focus:outline-none cursor-not-allowed"
                            readOnly
                        />
                    </div>
                </>
            )}

            {activeTab === 'history' && isEdit && (
                <HistoryViewer
                    filename={yamlFileName}
                    currentContent={yamlContent}
                    onRestore={(content) => {
                        setYamlContent(content);
                        setActiveTab('yaml');
                        void validateYaml(content);
                    }}
                />
            )}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex justify-end gap-3">
            {variant !== 'embedded' && (
                <Button
                    type="button"
                    onClick={() => router.back()}
                    variant="secondary"
                >
                    Cancel
                </Button>
            )}
            <Button
                type="submit"
                disabled={!!yamlError || !name || !selectedNode || isSaving}
                variant="primary"
            >
            {isSaving && <Loader2 size={16} className="animate-spin" />}
            {isSaving ? 'Saving…' : 'Save Service'}
            </Button>
        </div>

        {yamlError && (
            <div className="p-3 bg-status-fail/10 border border-status-fail/30 text-status-fail rounded-md shadow-sm flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
                <AlertCircle size={20} className="mt-0.5 shrink-0 text-status-fail" />
                <div className="flex-1 min-w-0">
                    <div className="text-sm">{yamlError.message}</div>
                    {yamlError.raw && yamlError.raw !== yamlError.message && (
                        <div className="mt-1">
                            <Button
                                type="button"
                                onClick={() => setShowParserDetails(!showParserDetails)}
                                variant="ghost"
                                size="sm"
                                className="flex items-center gap-1 text-[11px] uppercase tracking-wider font-bold cursor-pointer text-status-fail hover:text-status-fail select-none transition-colors"
                            >
                                {showParserDetails ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                                <span>Parser details</span>
                            </Button>
                            <div
                                ref={parserDetailsRef}
                                className="overflow-hidden"
                                style={{
                                    maxHeight: showParserDetails ? (parserDetailsHeight === 'auto' ? 'auto' : `${parserDetailsHeight}px`) : '0px',
                                    opacity: showParserDetails ? 1 : 0,
                                    transition: 'max-height 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 250ms cubic-bezier(0.16, 1, 0.3, 1)'
                                }}
                            >
                                <pre className="text-[11px] mt-1 font-mono whitespace-pre-wrap break-words text-status-fail/80">{yamlError.raw}</pre>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        )}
      </div>
    </form>
  );
}
