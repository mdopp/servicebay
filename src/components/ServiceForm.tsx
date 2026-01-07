/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import yaml from 'js-yaml';
import { Settings, FileCode, FileJson, FileText, AlertCircle, Network, HardDrive, Pencil, AlertTriangle, Clock, Server, Database, Plus, Copy } from 'lucide-react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-ini'; // For systemd/kube files (ini-like)
import 'prismjs/themes/prism-tomorrow.css'; // Dark theme for code
import HistoryViewer from './HistoryViewer';
import { getNodes } from '@/app/actions/system';
import { PodmanConnection } from '@/lib/nodes';

interface ServiceFormProps {
  initialData?: {
    name: string;
    kubeContent: string;
    yamlContent: string;
    yamlFileName: string;
    serviceContent?: string;
    kubePath?: string;
    yamlPath?: string;
    servicePath?: string;
  };
  isEdit?: boolean;
}

export default function ServiceForm({ initialData, isEdit }: ServiceFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nodeParam = searchParams?.get('node');
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
  const [selectedNode, setSelectedNode] = useState(nodeParam || '');
  
  const [name, setName] = useState(initialData?.name || '');
  const [kubeContent, setKubeContent] = useState(initialData?.kubeContent || '');
  const [yamlContent, setYamlContent] = useState(initialData?.yamlContent || '');
  const [yamlFileName, setYamlFileName] = useState(initialData?.yamlFileName || 'pod.yml');
  const [serviceContent] = useState(initialData?.serviceContent || '');
  const [description, setDescription] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [extractedPorts, setExtractedPorts] = useState<{ host?: string; container: string }[]>([]);
  const [extractedVolumes, setExtractedVolumes] = useState<{ host: string; container: string }[]>([]);

  // Volume Helpers
  const [availableVolumes, setAvailableVolumes] = useState<any[]>([]); // { Name, Driver... }
  
  // Rename Modal State
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [newServiceName, setNewServiceName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [activeTab, setActiveTab] = useState<'yaml' | 'kube' | 'service' | 'history'>('yaml');

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

  // Fetch volumes when node changes
  useEffect(() => {
    if (selectedNode) {
        fetch(`/api/volumes?node=${selectedNode}`)
            .then(res => res.json())
            .then(data => setAvailableVolumes(Array.isArray(data) ? data : []))
            .catch(e => console.error('Failed to fetch volumes:', e));
    } else {
        setAvailableVolumes([]);
    }
  }, [selectedNode]);

  // Initialize Description from KubeContent
  useEffect(() => {
    if (initialData?.kubeContent) {
        const match = initialData.kubeContent.match(/Description=(.+)/);
        if (match) {
            setDescription(match[1].trim());
        }
    }
  }, [initialData]);

  const updateCursorPosition = (e: any) => {
    const textarea = e.target;
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

  const extractInfo = (parsed: any) => {
    const ports: { host?: string; container: string }[] = [];
    const volumes: { host: string; container: string }[] = [];

    if (parsed && parsed.spec) {
        // Extract Ports
        if (parsed.spec.containers) {
            parsed.spec.containers.forEach((container: any) => {
                if (container.ports) {
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
            const volumeMap = new Map<string, string>(); // name -> hostPath
            
            parsed.spec.volumes.forEach((vol: any) => {
                if (vol.hostPath && vol.hostPath.path) {
                    volumeMap.set(vol.name, vol.hostPath.path);
                } else if (vol.persistentVolumeClaim) {
                        volumeMap.set(vol.name, `PVC:${vol.persistentVolumeClaim.claimName}`);
                }
            });

            parsed.spec.containers.forEach((container: any) => {
                if (container.volumeMounts) {
                    container.volumeMounts.forEach((mount: any) => {
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

  const insertAtCursor = (text: string) => {
    // Simple append if cursor tracking is hard, or we can try to use the last cursor position
    // Since 'cursorLine' updates on click/keyup, we can try to insert there.
    // However, react-simple-code-editor doesn't expose a clean way to insert at cursor programmatically easily without ref refs.
    // We will append to the end for safety, or copy to clipboard.
    // Let's copy to clipboard as primary action.
    navigator.clipboard.writeText(text);
    // Also try to update content if possible
    // For now, let's just use clipboard to avoid messing up the file
    alert('Snippet copied to clipboard! Paste it in the editor.');
  };

  const handleYamlChange = (content: string) => {
    setYamlContent(content);
    setYamlError(null);

    try {
      const parsed = yaml.load(content) as any;
      extractInfo(parsed);
      
      if (!isEdit && parsed && parsed.metadata && parsed.metadata.name) {
        const extractedName = parsed.metadata.name;
        
        if (!name || name === extractedName) {
          setName(extractedName);
          const newFileName = `${extractedName}.yml`;
          setYamlFileName(newFileName);
          setKubeContent(generateKubeContent(newFileName, autoUpdate, description));
        }
      }
    } catch (e: any) {
      setYamlError(e.message);
      setExtractedPorts([]);
      setExtractedVolumes([]);
    }
  };

  useEffect(() => {
    if (initialData?.yamlContent) {
        try {
            const parsed = yaml.load(initialData.yamlContent);
            extractInfo(parsed);
        } catch {}
    }
  }, [initialData]);

  useEffect(() => {
    if (name && yamlFileName) {
       if (!isEdit) {
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
    const query = selectedNode ? `?node=${selectedNode}` : '';
    const url = isEdit ? `/api/services/${name}${query}` : `/api/services${query}`;
    const method = isEdit ? 'PUT' : 'POST';

    await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, kubeContent, yamlContent, yamlFileName }),
    });

    router.push('/');
    router.refresh();
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

        // Redirect to the new service edit page
        router.push(`/edit/${newServiceName}`);
        router.refresh();
    } catch (e: any) {
        setRenameError(e.message);
        setIsRenaming(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 w-full">
      
      {/* Rename Modal */}
      {showRenameModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-md w-full p-6 animate-in fade-in zoom-in-95 duration-200 border border-gray-200 dark:border-gray-800">
                <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-2">
                    <Pencil size={20} /> Rename Service
                </h3>
                
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md p-4 mb-4 flex gap-3">
                    <AlertTriangle className="text-yellow-600 dark:text-yellow-400 shrink-0" size={24} />
                    <div className="text-sm text-yellow-800 dark:text-yellow-200">
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
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">New Service Name</label>
                    <input 
                        type="text" 
                        value={newServiceName}
                        onChange={(e) => setNewServiceName(e.target.value)}
                        className="w-full p-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        placeholder="my-new-service"
                        autoFocus
                    />
                </div>

                {renameError && (
                    <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-200 text-sm rounded border border-red-200 dark:border-red-800">
                        {renameError}
                    </div>
                )}

                <div className="flex justify-end gap-3">
                    <button 
                        type="button" 
                        onClick={() => setShowRenameModal(false)}
                        className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                        disabled={isRenaming}
                    >
                        Cancel
                    </button>
                    <button 
                        type="button"
                        onClick={handleRename}
                        disabled={!newServiceName || isRenaming}
                        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                    >
                        {isRenaming ? 'Renaming...' : 'Rename Service'}
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Top Section: Configuration */}
      <div className="bg-white dark:bg-gray-900 p-6 rounded-lg border border-gray-200 dark:border-gray-800 shadow-sm">
          <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-2">
              <Settings className="text-gray-700 dark:text-gray-300" size={24} /> Configuration
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
                <label className="block text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">Target Node</label>
                <div className="relative">
                    <select
                        value={selectedNode}
                        onChange={(e) => setSelectedNode(e.target.value)}
                        disabled={isEdit}
                        className="w-full p-3 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-md text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:text-gray-500 dark:disabled:text-gray-400 appearance-none"
                    >
                        <option value="" disabled>Select a node</option>
                        {nodes.map(n => (
                            <option key={n.Name} value={n.Name}>{n.Name} ({n.URI})</option>
                        ))}
                    </select>
                    <Server className="absolute right-3 top-3.5 text-gray-400 pointer-events-none" size={16} />
                </div>
            </div>

            <div>
                <label className="block text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">Service Name</label>
                <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isEdit}
                className="w-full p-3 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-md text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:text-gray-500 dark:disabled:text-gray-400"
                required
                />
            </div>

            <div>
                <label className="block text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">Description</label>
                <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full p-3 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-md text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Optional description"
                />
            </div>

            <div>
                <label className="block text-sm font-bold text-gray-900 dark:text-gray-100 mb-2">YAML Filename</label>
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={yamlFileName}
                        onChange={(e) => setYamlFileName(e.target.value)}
                        className="w-full p-3 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-md text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:text-gray-500 dark:disabled:text-gray-400"
                        required
                        disabled={isEdit} // Now disabled in edit mode
                    />
                    {isEdit && (
                        <button 
                            type="button"
                            onClick={() => {
                                setNewServiceName(name);
                                setShowRenameModal(true);
                            }}
                            className="px-3 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                            title="Rename Service & Files"
                        >
                            <Pencil size={18} />
                        </button>
                    )}
                </div>
            </div>

            <div className="flex items-end pb-3 md:col-span-3">
                <label className="flex items-center gap-3 cursor-pointer">
                    <input 
                        type="checkbox" 
                        checked={autoUpdate} 
                        onChange={(e) => setAutoUpdate(e.target.checked)}
                        className="w-5 h-5 text-blue-600 rounded border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus:ring-blue-500"
                    />
                    <span className="text-base text-gray-900 dark:text-gray-100 font-medium">Enable AutoUpdate (registry)</span>
                </label>
            </div>
          </div>

          {/* Extracted Info */}
          {(extractedPorts.length > 0 || extractedVolumes.length > 0) && (
            <div className="mt-6 pt-6 border-t border-gray-100 dark:border-gray-800 grid grid-cols-1 md:grid-cols-2 gap-6">
                {extractedPorts.length > 0 && (
                    <div>
                        <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
                            <Network size={16} /> Ports
                        </h4>
                        <div className="flex flex-wrap gap-2">
                            {extractedPorts.map((port, i) => (
                                <div key={i} className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-600 dark:text-gray-300">
                                    {port.host ? (
                                        <>
                                            <span className="text-blue-600 dark:text-blue-400 font-semibold">{port.host}</span>
                                            <span className="text-gray-400 dark:text-gray-500 mx-1">→</span>
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
                        <h4 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
                            <HardDrive size={16} /> Volumes
                        </h4>
                        <div className="flex flex-col gap-1">
                            {extractedVolumes.map((vol, i) => (
                                <div key={i} className="text-xs font-mono truncate" title={`${vol.host} → ${vol.container}`}>
                                    <span className="text-orange-600 dark:text-orange-400">{vol.host}</span>
                                    <span className="text-gray-400 dark:text-gray-500 mx-1">→</span>
                                    <span className="text-green-600 dark:text-green-400">{vol.container}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
          )}
      </div>

      {/* Editors Tabs */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
        <div className="flex border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
            <button
                type="button"
                className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'yaml' ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-t-2 border-t-blue-600 dark:border-t-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
                onClick={() => setActiveTab('yaml')}
            >
                <FileCode size={16} /> YAML Definition
            </button>
            <button
                type="button"
                className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'kube' ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-t-2 border-t-blue-600 dark:border-t-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
                onClick={() => setActiveTab('kube')}
            >
                <FileJson size={16} /> Generated .kube
            </button>
            {isEdit && serviceContent && (
                <button
                    type="button"
                    className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'service' ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-t-2 border-t-blue-600 dark:border-t-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
                    onClick={() => setActiveTab('service')}
                >
                    <FileText size={16} /> Generated Service Unit
                </button>
            )}
            {isEdit && (
                <button
                    type="button"
                    className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'history' ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-t-2 border-t-blue-600 dark:border-t-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
                    onClick={() => setActiveTab('history')}
                >

                    {/* Volume Helper Toolbar */}
                    {availableVolumes.length > 0 && (
                        <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-md flex flex-wrap items-center gap-4">
                            <span className="text-xs font-bold text-blue-800 dark:text-blue-300 flex items-center gap-2">
                                <Database size={14} /> Available Volumes:
                            </span>
                            <div className="flex flex-wrap gap-2">
                                {availableVolumes.map(vol => (
                                    <div key={vol.Name} className="group relative inline-flex">
                                        <div className="px-2 py-1 bg-white dark:bg-gray-800 border border-blue-200 dark:border-blue-700 rounded text-xs text-blue-700 dark:text-blue-300 font-mono flex items-center gap-2">
                                            {vol.Name}
                                            <div className="flex gap-1 ml-1 pl-1 border-l border-gray-200 dark:border-gray-700 opacity-50 group-hover:opacity-100 transition-opacity">
                                                <button 
                                                    type="button"
                                                    onClick={() => insertAtCursor(`  - name: ${vol.Name}\n    persistentVolumeClaim:\n      claimName: ${vol.Name}`)}
                                                    className="hover:text-blue-900 dark:hover:text-blue-100"
                                                    title="Copy Volume Definition (spec.volumes)"
                                                >
                                                    <Plus size={12} />
                                                </button>
                                                <button 
                                                    type="button"
                                                    onClick={() => insertAtCursor(`  - name: ${vol.Name}\n    mountPath: /data`)}
                                                    className="hover:text-blue-900 dark:hover:text-blue-100"
                                                    title="Copy Mount (volumeMounts)"
                                                >
                                                    <Copy size={12} />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <span className="text-[10px] text-blue-600/70 dark:text-blue-400/70 ml-auto">
                                Click (+): Copy Definition | Click (Cp): Copy Mount
                            </span>
                        </div>
                    )}

                    <Clock size={16} /> History
                </button>
            )}
        </div>

        <div className="p-6">
            {activeTab === 'yaml' && (
                <>
                    {initialData?.yamlPath && (
                        <div className="mb-2 text-sm text-gray-500 dark:text-gray-400 font-mono bg-gray-50 dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700 break-all">
                        {initialData.yamlPath}
                        </div>
                    )}
                    <p className="text-base text-gray-700 dark:text-gray-300 mb-4">
                        Paste your Kubernetes YAML here. We will automatically extract the service name and generate the configuration.
                    </p>
                    <div className="border border-gray-300 dark:border-gray-700 rounded-md overflow-hidden bg-[#2d2d2d] dark:bg-black relative group">
                        <div className="absolute top-2 right-4 z-10 text-xs text-gray-400 font-mono bg-black/30 px-2 py-1 rounded pointer-events-none">
                            Line: {cursorLine}
                        </div>
                        <Editor
                        value={yamlContent}
                        onValueChange={handleYamlChange}
                        highlight={code => Prism.highlight(code, Prism.languages.yaml, 'yaml')}
                        padding={16}
                        style={{
                            fontFamily: '"Fira code", "Fira Mono", monospace',
                            fontSize: 14,
                            minHeight: '500px',
                            color: '#f8f8f2', // Light text for dark theme
                        }}
                        textareaClassName="focus:outline-none"
                        placeholder="apiVersion: v1&#10;kind: Pod&#10;metadata:&#10;  name: my-service..."
                        onSelect={updateCursorPosition}
                        onClick={updateCursorPosition}
                        onKeyUp={updateCursorPosition}
                        />
                    </div>
                </>
            )}

            {activeTab === 'kube' && (
                <>
                    {initialData?.kubePath && (
                        <div className="mb-2 text-sm text-gray-500 dark:text-gray-400 font-mono bg-gray-50 dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700 break-all">
                        {initialData.kubePath}
                        </div>
                    )}
                    <div className="border border-gray-300 dark:border-gray-700 rounded-md overflow-hidden bg-[#2d2d2d] dark:bg-black">
                        <Editor
                        value={kubeContent}
                        onValueChange={() => {}} // Read-only
                        highlight={code => Prism.highlight(code, Prism.languages.ini || Prism.languages.text, 'ini')}
                        padding={16}
                        style={{
                            fontFamily: '"Fira code", "Fira Mono", monospace',
                            fontSize: 14,
                            minHeight: '500px',
                            color: '#f8f8f2',
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
                        <div className="mb-2 text-sm text-gray-500 dark:text-gray-400 font-mono bg-gray-50 dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700 break-all">
                        {initialData.servicePath}
                        </div>
                    )}
                    <div className="border border-gray-300 dark:border-gray-700 rounded-md overflow-hidden bg-[#2d2d2d] dark:bg-black">
                        <Editor
                            value={serviceContent}
                            onValueChange={() => {}} // Read-only
                            highlight={code => Prism.highlight(code, Prism.languages.ini || Prism.languages.text, 'ini')}
                            padding={16}
                            style={{
                            fontFamily: '"Fira code", "Fira Mono", monospace',
                            fontSize: 14,
                            minHeight: '500px',
                            color: '#f8f8f2',
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
                        // Trigger validation/extraction logic
                        try {
                            const parsed = yaml.load(content);
                            extractInfo(parsed);
                            setYamlError(null);
                        } catch (e: any) {
                            setYamlError(e.message);
                        }
                    }}
                />
            )}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex justify-end gap-3">
            <button type="button" onClick={() => router.back()} className="px-6 py-3 border border-gray-300 dark:border-gray-700 rounded-md text-gray-700 dark:text-gray-300 font-medium hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500">
            Cancel
            </button>
            <button 
                type="submit" 
                disabled={!!yamlError || !name || !selectedNode}
                className="px-6 py-3 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
            Save Service
            </button>
        </div>

        {yamlError && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-200 rounded-md shadow-sm flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
                <AlertCircle size={20} className="mt-0.5 shrink-0 text-red-500 dark:text-red-400" />
                <div className="text-sm font-mono whitespace-pre-wrap">{yamlError}</div>
            </div>
        )}
      </div>
    </form>
  );
}
