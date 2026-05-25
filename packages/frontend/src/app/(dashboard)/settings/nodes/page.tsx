'use client';

import { useState } from 'react';
import {
  Server,
  Key,
  Terminal,
  Plus,
  Loader2,
  Save,
  XCircle,
  CheckCircle2,
  Trash2,
  Edit2,
  Globe,
  ShieldAlert,
  WifiOff,
} from 'lucide-react';
import { useSettings } from '../_lib/SettingsContext';
import { PodmanConnection } from '@/lib/nodes';

export default function NodesSettingsPage() {
  const {
    nodes,
    nodeHealth,
    submitNode,
    removeNode,
    setDefault,
    openSSHModal,
    parseDestination,
    router,
  } = useSettings();

  const [newNodeName, setNewNodeName] = useState('');
  const [newNodeDest, setNewNodeDest] = useState('');
  const [newNodeIdentity, setNewNodeIdentity] = useState('/app/data/ssh/id_rsa');
  const [addingNode, setAddingNode] = useState(false);

  const [editingNode, setEditingNode] = useState<string | null>(null);
  const [nodeDraft, setNodeDraft] = useState<{ name: string; destination: string; identity: string }>({
    name: '',
    destination: '',
    identity: '/app/data/ssh/id_rsa',
  });
  const [savingNode, setSavingNode] = useState(false);

  const handleAddNode = async () => {
    setAddingNode(true);
    const ok = await submitNode('create', {
      name: newNodeName.trim(),
      destination: newNodeDest.trim(),
      identity: newNodeIdentity.trim(),
    });
    if (ok) {
      setNewNodeName('');
      setNewNodeDest('');
      setNewNodeIdentity('/app/data/ssh/id_rsa');
    }
    setAddingNode(false);
  };

  const startEditingNode = (node: PodmanConnection) => {
    setEditingNode(node.Name);
    setNodeDraft({ name: node.Name, destination: node.URI, identity: node.Identity });
  };

  const cancelInlineEdit = () => {
    setEditingNode(null);
    setNodeDraft({ name: '', destination: '', identity: '/app/data/ssh/id_rsa' });
  };

  const handleInlineSave = async () => {
    if (!editingNode) return;
    setSavingNode(true);
    const ok = await submitNode('edit', {
      originalName: editingNode,
      name: nodeDraft.name.trim(),
      destination: nodeDraft.destination.trim(),
      identity: nodeDraft.identity.trim(),
    });
    if (ok) {
      setEditingNode(null);
      setNodeDraft({ name: '', destination: '', identity: '/app/data/ssh/id_rsa' });
    }
    setSavingNode(false);
  };

  const handleDeploySSHKey = (node: PodmanConnection) => {
    openSSHModal(parseDestination(node.URI));
  };

  const handleOpenTerminal = (node: PodmanConnection) => {
    router.push(`/terminal?node=${encodeURIComponent(node.Name)}`);
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600 dark:text-blue-400">
          <Server size={20} />
        </div>
        <div>
          <h3 className="font-bold text-gray-900 dark:text-white">System Connections</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">Manage remote Podman nodes</p>
        </div>
        <div className="ml-auto">
          <button
            onClick={() => openSSHModal()}
            className="text-xs flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
          >
            <Terminal size={14} />
            Setup SSH Keys
          </button>
        </div>
      </div>

      <div className="p-6 space-y-6">
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 flex gap-3 items-start">
          <div className="mt-0.5 text-blue-600 dark:text-blue-400">
            <Key size={16} />
          </div>
          <div className="text-sm text-blue-800 dark:text-blue-200">
            <p className="font-medium mb-1">SSH Access Required</p>
            <p className="opacity-90 text-xs">
              ServiceBay requires password-less SSH access to remote nodes.
              If you haven&apos;t set this up, use the
              <button onClick={() => openSSHModal()} className="mx-1 underline font-medium hover:text-blue-600">
                Setup SSH Keys
              </button>
              tool to copy your public key to the server.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end mb-6" id="node-form">
          <div className="md:col-span-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
            <input
              type="text"
              value={newNodeName}
              onChange={e => setNewNodeName(e.target.value)}
              disabled={addingNode}
              className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50"
              placeholder="my-node"
            />
          </div>
          <div className="md:col-span-5">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Destination (SSH)</label>
            <input
              type="text"
              value={newNodeDest}
              onChange={e => setNewNodeDest(e.target.value)}
              disabled={addingNode}
              className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder="ssh://user@host:port"
            />
          </div>
          <div className="md:col-span-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Identity File</label>
            <div className="relative">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={newNodeIdentity}
                onChange={e => setNewNodeIdentity(e.target.value)}
                disabled={addingNode}
                className="w-full pl-9 pr-2 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                placeholder="/app/data/ssh/id_rsa"
              />
            </div>
          </div>
          <div className="md:col-span-1 flex gap-2">
            <button
              onClick={handleAddNode}
              disabled={addingNode || !newNodeName.trim() || !newNodeDest.trim() || !newNodeIdentity.trim()}
              className="w-full p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2"
              title="Add Node"
            >
              {addingNode ? <Loader2 className="animate-spin" size={20} /> : <Plus size={20} />}
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {nodes.map(node => {
            const health = nodeHealth[node.Name] || { loading: false, online: false, auth: false };
            const isEditing = editingNode === node.Name;
            const displayName = isEditing ? (nodeDraft.name || node.Name) : node.Name;
            const inlineDisabled = savingNode || !nodeDraft.name.trim() || !nodeDraft.destination.trim() || !nodeDraft.identity.trim();

            return (
              <div
                key={node.Name}
                className={`flex flex-col gap-4 md:flex-row md:items-start md:justify-between p-4 rounded-lg border transition-colors ${
                  isEditing
                    ? 'bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800'
                    : 'bg-gray-50 dark:bg-gray-900/50 border-gray-200 dark:border-gray-700'
                }`}
              >
                <div className="flex-1 space-y-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-2 h-2 rounded-full ${node.Default ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                      title={node.Default ? 'Default Node' : ''}
                    />
                    <div>
                      <div className="font-medium text-gray-900 dark:text-white flex flex-wrap items-center gap-2">
                        {displayName}
                        {node.Default && (
                          <span className="text-[10px] bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded uppercase font-bold">
                            Default
                          </span>
                        )}
                        <div
                          className="flex items-center gap-1 ml-1"
                          title={
                            health.error ||
                            (health.online
                              ? health.auth
                                ? 'Online & Authenticated'
                                : 'Online but Auth Failed'
                              : 'Unreachable')
                          }
                        >
                          {health.loading ? (
                            <Loader2 size={14} className="animate-spin text-gray-400" />
                          ) : health.online && health.auth ? (
                            <div className="flex items-center text-green-500 gap-1 text-[10px] bg-white dark:bg-gray-800 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700 shadow-sm">
                              <Globe size={10} />
                              <span>Connected</span>
                            </div>
                          ) : health.online && !health.auth ? (
                            <div className="flex items-center text-yellow-500 gap-1 text-[10px] bg-white dark:bg-gray-800 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700 shadow-sm cursor-help">
                              <ShieldAlert size={10} />
                              <span>Auth Failed</span>
                            </div>
                          ) : (
                            <div className="flex items-center text-red-500 gap-1 text-[10px] bg-white dark:bg-gray-800 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700 shadow-sm cursor-help">
                              <WifiOff size={10} />
                              <span>Offline</span>
                            </div>
                          )}
                        </div>
                      </div>
                      {!isEditing && <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">{node.URI}</div>}
                    </div>
                  </div>

                  {isEditing && (
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                      <div className="md:col-span-3">
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Name</label>
                        <input
                          type="text"
                          value={nodeDraft.name}
                          onChange={e => setNodeDraft(prev => ({ ...prev, name: e.target.value }))}
                          disabled={savingNode}
                          className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                          placeholder="my-node"
                        />
                      </div>
                      <div className="md:col-span-5">
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Destination (SSH)</label>
                        <input
                          type="text"
                          value={nodeDraft.destination}
                          onChange={e => setNodeDraft(prev => ({ ...prev, destination: e.target.value }))}
                          disabled={savingNode}
                          className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                          placeholder="ssh://user@host:port"
                        />
                      </div>
                      <div className="md:col-span-4">
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Identity File</label>
                        <input
                          type="text"
                          value={nodeDraft.identity}
                          onChange={e => setNodeDraft(prev => ({ ...prev, identity: e.target.value }))}
                          disabled={savingNode}
                          className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                          placeholder="/app/data/ssh/id_rsa"
                        />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {isEditing ? (
                    <>
                      <button
                        onClick={handleInlineSave}
                        disabled={inlineDisabled}
                        className="p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Save changes"
                      >
                        {savingNode ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                      </button>
                      <button
                        onClick={cancelInlineEdit}
                        className="p-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                        title="Cancel"
                      >
                        <XCircle size={18} />
                      </button>
                    </>
                  ) : (
                    <>
                      {!node.Default && (
                        <button
                          onClick={() => setDefault(node.Name)}
                          className="p-2 text-gray-500 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded transition-colors"
                          title="Set as Default"
                        >
                          <CheckCircle2 size={16} />
                        </button>
                      )}
                      <button
                        onClick={() => handleDeploySSHKey(node)}
                        className="p-2 text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded transition-colors"
                        title="Deploy SSH key to this node"
                      >
                        <Key size={16} />
                      </button>
                      <button
                        onClick={() => handleOpenTerminal(node)}
                        className="p-2 text-gray-500 hover:text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded transition-colors"
                        title="Open SSH terminal for this node"
                      >
                        <Terminal size={16} />
                      </button>
                      <button
                        onClick={() => startEditingNode(node)}
                        className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
                        title="Edit Node settings"
                      >
                        <Edit2 size={16} />
                      </button>
                      <button
                        onClick={() => removeNode(node.Name)}
                        className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
                        title="Remove Node"
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {nodes.length === 0 && (
            <div className="text-center py-4 text-gray-500 dark:text-gray-400 text-sm italic">
              No remote nodes configured. ServiceBay is running in local mode.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
