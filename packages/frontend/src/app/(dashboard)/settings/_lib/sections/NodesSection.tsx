'use client';

import { useState } from 'react';
import {
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
import { Badge, Button } from '@/components/ui';
import { useSettings } from '../SettingsContext';
import { PodmanConnection } from '@/lib/nodes';

// Shared token-based input chrome for this section's node fields.
const NODE_INPUT_CLASS =
  'w-full p-2 rounded-card border border-border bg-surface-2 text-text focus:ring-2 focus:ring-accent outline-none disabled:opacity-50 disabled:cursor-not-allowed';

export default function NodesSection() {
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
    <>
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => openSSHModal()}>
            <Terminal size={14} />
            Setup SSH Keys
          </Button>
        </div>

        <div className="bg-accent/10 border border-accent/20 rounded-card p-3 flex gap-3 items-start">
          <div className="mt-0.5 text-accent">
            <Key size={16} />
          </div>
          <div className="text-sm text-text">
            <p className="font-medium mb-1">SSH Access Required</p>
            <p className="text-text-muted text-xs">
              ServiceBay requires password-less SSH access to remote nodes.
              If you haven&apos;t set this up, use the
              <button onClick={() => openSSHModal()} className="mx-1 underline font-medium text-accent hover:text-accent-strong">
                Setup SSH Keys
              </button>
              tool to copy your public key to the server.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end mb-6" id="node-form">
          <div className="md:col-span-3">
            <label className="block text-sm font-medium text-text-muted mb-1">Name</label>
            <input
              type="text"
              value={newNodeName}
              onChange={e => setNewNodeName(e.target.value)}
              disabled={addingNode}
              className={NODE_INPUT_CLASS}
              placeholder="my-node"
            />
          </div>
          <div className="md:col-span-5">
            <label className="block text-sm font-medium text-text-muted mb-1">Destination (SSH)</label>
            <input
              type="text"
              value={newNodeDest}
              onChange={e => setNewNodeDest(e.target.value)}
              disabled={addingNode}
              className={NODE_INPUT_CLASS}
              placeholder="ssh://user@host:port"
            />
          </div>
          <div className="md:col-span-3">
            <label className="block text-sm font-medium text-text-muted mb-1">Identity File</label>
            <div className="relative">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-subtle" />
              <input
                type="text"
                value={newNodeIdentity}
                onChange={e => setNewNodeIdentity(e.target.value)}
                disabled={addingNode}
                className={`${NODE_INPUT_CLASS} pl-9`}
                placeholder="/app/data/ssh/id_rsa"
              />
            </div>
          </div>
          <div className="md:col-span-1 flex gap-2">
            <Button
              onClick={handleAddNode}
              disabled={addingNode || !newNodeName.trim() || !newNodeDest.trim() || !newNodeIdentity.trim()}
              aria-label="Add Node"
              title="Add Node"
              className="w-full"
            >
              {addingNode ? <Loader2 className="animate-spin" size={20} /> : <Plus size={20} />}
            </Button>
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
                className={`flex flex-col gap-4 md:flex-row md:items-start md:justify-between p-4 rounded-card border transition-colors ${
                  isEditing
                    ? 'bg-accent/10 border-accent/30'
                    : 'bg-surface-2 border-border'
                }`}
              >
                <div className="flex-1 space-y-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-2 h-2 rounded-chip ${node.Default ? 'bg-status-ok' : 'bg-text-subtle'}`}
                      title={node.Default ? 'Default Node' : ''}
                    />
                    <div>
                      <div className="font-medium text-text flex flex-wrap items-center gap-2">
                        {displayName}
                        {node.Default && (
                          <Badge variant="ok" className="uppercase font-bold">Default</Badge>
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
                            <Loader2 size={14} className="animate-spin text-text-subtle" />
                          ) : health.online && health.auth ? (
                            <Badge variant="ok"><Globe size={10} /><span>Connected</span></Badge>
                          ) : health.online && !health.auth ? (
                            <Badge variant="warn" className="cursor-help"><ShieldAlert size={10} /><span>Auth Failed</span></Badge>
                          ) : (
                            <Badge variant="fail" className="cursor-help"><WifiOff size={10} /><span>Offline</span></Badge>
                          )}
                        </div>
                      </div>
                      {!isEditing && <div className="text-xs text-text-muted font-mono">{node.URI}</div>}
                    </div>
                  </div>

                  {isEditing && (
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                      <div className="md:col-span-3">
                        <label className="block text-xs font-medium text-text-muted mb-1">Name</label>
                        <input
                          type="text"
                          value={nodeDraft.name}
                          onChange={e => setNodeDraft(prev => ({ ...prev, name: e.target.value }))}
                          disabled={savingNode}
                          className={`${NODE_INPUT_CLASS} text-sm`}
                          placeholder="my-node"
                        />
                      </div>
                      <div className="md:col-span-5">
                        <label className="block text-xs font-medium text-text-muted mb-1">Destination (SSH)</label>
                        <input
                          type="text"
                          value={nodeDraft.destination}
                          onChange={e => setNodeDraft(prev => ({ ...prev, destination: e.target.value }))}
                          disabled={savingNode}
                          className={`${NODE_INPUT_CLASS} text-sm`}
                          placeholder="ssh://user@host:port"
                        />
                      </div>
                      <div className="md:col-span-4">
                        <label className="block text-xs font-medium text-text-muted mb-1">Identity File</label>
                        <input
                          type="text"
                          value={nodeDraft.identity}
                          onChange={e => setNodeDraft(prev => ({ ...prev, identity: e.target.value }))}
                          disabled={savingNode}
                          className={`${NODE_INPUT_CLASS} text-sm`}
                          placeholder="/app/data/ssh/id_rsa"
                        />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {isEditing ? (
                    <>
                      <Button
                        onClick={handleInlineSave}
                        disabled={inlineDisabled}
                        aria-label="Save changes"
                        title="Save changes"
                      >
                        {savingNode ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={cancelInlineEdit}
                        aria-label="Cancel"
                        title="Cancel"
                      >
                        <XCircle size={18} />
                      </Button>
                    </>
                  ) : (
                    <>
                      {!node.Default && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDefault(node.Name)}
                          aria-label="Set as Default"
                          title="Set as Default"
                        >
                          <CheckCircle2 size={16} />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeploySSHKey(node)}
                        aria-label="Deploy SSH key to this node"
                        title="Deploy SSH key to this node"
                      >
                        <Key size={16} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleOpenTerminal(node)}
                        aria-label="Open SSH terminal for this node"
                        title="Open SSH terminal for this node"
                      >
                        <Terminal size={16} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => startEditingNode(node)}
                        aria-label="Edit Node settings"
                        title="Edit Node settings"
                      >
                        <Edit2 size={16} />
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => removeNode(node.Name)}
                        aria-label="Remove Node"
                        title="Remove Node"
                      >
                        <Trash2 size={16} />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {nodes.length === 0 && (
            <div className="text-center py-4 text-text-muted text-sm italic">
              No remote nodes configured. ServiceBay is running in local mode.
            </div>
          )}
        </div>
    </>
  );
}
