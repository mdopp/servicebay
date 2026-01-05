'use client';

import { useState, useEffect } from 'react';
import { Template } from '@/lib/registry';
import { fetchTemplateYaml } from '@/app/actions';
import { getNodes } from '@/app/actions/system';
import { PodmanConnection } from '@/lib/nodes';
import { Layers, Loader2, AlertCircle, X, Folder, Server } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Mustache from 'mustache';

interface InstallerModalProps {
  template: Template;
  readme: string;
  isOpen: boolean;
  onClose: () => void;
}

interface StackItem {
  name: string;
  checked: boolean;
  yaml?: string;
}

interface Variable {
  name: string;
  value: string;
}

export default function InstallerModal({ template, readme, isOpen, onClose }: InstallerModalProps) {
  const router = useRouter();
  const [step, setStep] = useState<'select' | 'configure' | 'installing' | 'done'>('select');
  const [items, setItems] = useState<StackItem[]>([]);
  const [variables, setVariables] = useState<Variable[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
  const [selectedNode, setSelectedNode] = useState('');

  useEffect(() => {
    getNodes().then(setNodes);
  }, []);

  // Initialize items based on type
  useEffect(() => {
    if (!isOpen) return;

    // Reset state when opening
    setStep('select');
    setVariables([]);
    setLogs([]);
    setError(null);

    if (template.type === 'stack') {
        const lines = readme.split('\n');
        const parsedItems: StackItem[] = [];
        const regex = /-\s*\[([ xX])\]\s*([\w\d_-]+)/;

        lines.forEach(line => {
            const match = line.match(regex);
            if (match) {
                parsedItems.push({
                    name: match[2].trim(),
                    checked: match[1].toLowerCase() === 'x'
                });
            }
        });
        setItems(parsedItems);
    } else {
        // Single template
        setItems([{ name: template.name, checked: true }]);
        // Auto-advance to configure for single templates
        // We need to trigger this after render, so we'll use a timeout or effect
        // But fetchYamlsAndExtractVars depends on state 'items', which we just set.
        // Better to handle this in the next effect or manually call it if we can ensure state is updated.
        // Actually, let's just set step to 'select' and let the user click "Continue" or auto-advance?
        // User requested "overlay ... das die variablen abfragt".
        // So skipping selection is good.
    }
  }, [isOpen, template, readme]);

  // Auto-advance for single templates
  useEffect(() => {
    if (isOpen && template.type === 'template' && items.length > 0 && step === 'select') {
        fetchYamlsAndExtractVars();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, isOpen, template, step]);


  const handleToggle = (index: number) => {
    const newItems = [...items];
    newItems[index].checked = !newItems[index].checked;
    setItems(newItems);
  };

  const fetchYamlsAndExtractVars = async () => {
    setStep('configure');
    setError(null);
    const selectedItems = items.filter(i => i.checked);
    const vars = new Set<string>();
    const newItems = [...items];

    for (const item of selectedItems) {
        try {
            // If we already have yaml (e.g. re-running), skip fetch? No, safer to fetch.
            const yaml = await fetchTemplateYaml(item.name, template.source);
            if (!yaml) {
                throw new Error(`Could not fetch template for ${item.name}`);
            }
            
            const idx = newItems.findIndex(i => i.name === item.name);
            if (idx !== -1) newItems[idx].yaml = yaml;

            const matches = yaml.matchAll(/\{\{\s*([\w\d_]+)\s*\}\}/g);
            for (const match of matches) {
                vars.add(match[1]);
            }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            setError(e.message);
            return;
        }
    }

    setItems(newItems);
    setVariables(Array.from(vars).map(v => ({ name: v, value: '' })));
  };

  const handleInstall = async () => {
    setStep('installing');
    setLogs([]);
    const selectedItems = items.filter(i => i.checked);

    for (const item of selectedItems) {
        if (!item.yaml) continue;

        setLogs(prev => [...prev, `Installing ${item.name}...`]);

        const view = variables.reduce((acc, v) => ({ ...acc, [v.name]: v.value }), {});
        const content = Mustache.render(item.yaml, view);

        const kubeContent = `[Kube]
Yaml=${item.name}.yml
AutoUpdate=registry

[Install]
WantedBy=default.target`;

        try {
            const query = selectedNode ? `?node=${selectedNode}` : '';
            const res = await fetch(`/api/services${query}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: item.name,
                    kubeContent,
                    yamlContent: content,
                    yamlFileName: `${item.name}.yml`
                }),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Unknown error');
            }
            setLogs(prev => [...prev, `✅ ${item.name} installed successfully.`]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            setLogs(prev => [...prev, `❌ Failed to install ${item.name}: ${e.message}`]);
        }
    }
    setStep('done');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
            
            {/* Header */}
            <div className="p-6 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center">
                <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                    {template.type === 'stack' ? <Layers className="text-purple-600 dark:text-purple-400" /> : <Folder className="text-blue-600 dark:text-blue-400" />}
                    Install {template.type === 'stack' ? 'Stack' : 'Template'}: {template.name}
                </h3>
                <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                    <X size={24} />
                </button>
            </div>

            {/* Content */}
            <div className="p-6 overflow-y-auto flex-1">
                {step === 'select' && (
                    <div>
                        {items.length === 0 ? (
                             <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200 rounded border border-yellow-200 dark:border-yellow-800">
                                No service definitions found in this stack&apos;s README.
                                <br/>
                                <small>Expected format: <code>- [x] service-name</code></small>
                            </div>
                        ) : (
                            <>
                                <p className="mb-4 text-gray-600 dark:text-gray-400">Select the services you want to include:</p>
                                <div className="space-y-2 mb-6">
                                    {items.map((item, i) => (
                                        <label key={item.name} className="flex items-center gap-3 p-3 border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors">
                                            <input 
                                                type="checkbox" 
                                                checked={item.checked} 
                                                onChange={() => handleToggle(i)}
                                                className="w-5 h-5 text-blue-600 rounded focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600"
                                            />
                                            <span className="font-medium text-gray-900 dark:text-gray-200">{item.name}</span>
                                        </label>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                )}

                {step === 'configure' && (
                    <div>
                        <div className="mb-6">
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Target Node</label>
                            <div className="relative">
                                <select
                                    value={selectedNode}
                                    onChange={(e) => setSelectedNode(e.target.value)}
                                    className="w-full p-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded focus:ring-2 focus:ring-blue-500 appearance-none"
                                >
                                    <option value="" disabled>Select a node</option>
                                    {nodes.map(n => (
                                        <option key={n.Name} value={n.Name}>{n.Name} ({n.URI})</option>
                                    ))}
                                </select>
                                <Server className="absolute right-3 top-2.5 text-gray-400 pointer-events-none" size={16} />
                            </div>
                        </div>

                        <p className="mb-4 text-gray-600 dark:text-gray-400">Configure variables:</p>
                        {variables.length > 0 ? (
                            <div className="grid gap-4 mb-6">
                                {variables.map((v, i) => (
                                    <div key={v.name}>
                                        <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">{v.name}</label>
                                        <input 
                                            type="text" 
                                            value={v.value}
                                            onChange={(e) => {
                                                const newVars = [...variables];
                                                newVars[i].value = e.target.value;
                                                setVariables(newVars);
                                            }}
                                            className="w-full p-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded focus:ring-2 focus:ring-blue-500"
                                            placeholder={`Value for ${v.name}`}
                                        />
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="p-4 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 rounded mb-6">
                                No variables found. You can proceed.
                            </div>
                        )}
                        
                        {error && (
                            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-200 rounded flex items-center gap-2">
                                <AlertCircle size={18} /> {error}
                            </div>
                        )}
                    </div>
                )}

                {(step === 'installing' || step === 'done') && (
                    <div>
                        <div className="bg-gray-900 text-gray-100 p-4 rounded-md font-mono text-sm h-64 overflow-y-auto mb-4 border border-gray-800">
                            {logs.map((log, i) => (
                                <div key={i} className="mb-1">{log}</div>
                            ))}
                            {step === 'installing' && (
                                <div className="flex items-center gap-2 text-gray-400 mt-2">
                                    <Loader2 size={14} className="animate-spin" /> Processing...
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-gray-200 dark:border-gray-800 flex justify-end gap-3 bg-gray-50 dark:bg-gray-900/50 rounded-b-lg">
                {step === 'select' && (
                    <>
                        <button onClick={onClose} className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 rounded transition-colors">Cancel</button>
                        <button 
                            onClick={fetchYamlsAndExtractVars}
                            disabled={items.filter(i => i.checked).length === 0}
                            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-medium transition-colors"
                        >
                            Continue
                        </button>
                    </>
                )}
                {step === 'configure' && (
                    <>
                        <button 
                            onClick={() => template.type === 'stack' ? setStep('select') : onClose()}
                            className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 rounded transition-colors"
                        >
                            {template.type === 'stack' ? 'Back' : 'Cancel'}
                        </button>
                        <button 
                            onClick={handleInstall}
                            disabled={!selectedNode}
                            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Install
                        </button>
                    </>
                )}
                {step === 'installing' && (
                    <button disabled className="px-4 py-2 bg-gray-400 text-white rounded cursor-not-allowed">Installing...</button>
                )}
                {step === 'done' && (
                    <button 
                        onClick={() => {
                            onClose();
                            router.push('/');
                        }}
                        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-medium transition-colors"
                    >
                        Go to Dashboard
                    </button>
                )}
            </div>
        </div>
    </div>
  );
}
