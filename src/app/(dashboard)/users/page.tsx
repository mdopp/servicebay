'use client';

import { useState, useEffect, useCallback } from 'react';
import { Users, Shield, Plus, Trash2, UserPlus, UserMinus, Loader2, Sprout, ChevronDown, ChevronUp } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import type { LldapUser, LldapGroup } from '@/lib/lldap';

export default function UsersPage() {
  const { addToast } = useToast();
  const [activeTab, setActiveTab] = useState<'users' | 'groups'>('users');
  const [users, setUsers] = useState<LldapUser[]>([]);
  const [groups, setGroups] = useState<LldapGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [notConfigured, setNotConfigured] = useState(false);

  // Create user form
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUser, setNewUser] = useState({ id: '', email: '', displayName: '', firstName: '', lastName: '' });
  const [newUserGroups, setNewUserGroups] = useState<number[]>([]);
  const [creating, setCreating] = useState(false);

  // Create group form
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');

  // Delete confirmation
  const [deleteModal, setDeleteModal] = useState<{ type: 'user' | 'group'; id: string | number; name: string } | null>(null);

  // Expanded user rows
  const [expandedUser, setExpandedUser] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, groupsRes] = await Promise.all([
        fetch('/api/users'),
        fetch('/api/groups'),
      ]);

      if (usersRes.status === 503 || groupsRes.status === 503) {
        setNotConfigured(true);
        setLoading(false);
        return;
      }

      if (usersRes.ok) setUsers(await usersRes.json());
      if (groupsRes.ok) setGroups(await groupsRes.json());
    } catch {
      addToast('error', 'Connection failed', 'Could not connect to LLDAP');
    }
    setLoading(false);
  }, [addToast]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount pattern
  useEffect(() => { void fetchData(); }, [fetchData]);

  const handleSeedGroups = async () => {
    try {
      const res = await fetch('/api/groups/seed', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        addToast('success', 'Groups seeded', data.message);
        fetchData();
      } else {
        addToast('error', 'Seed failed', data.error);
      }
    } catch {
      addToast('error', 'Error', 'Failed to seed groups');
    }
  };

  const handleCreateUser = async () => {
    if (!newUser.id || !newUser.email) return;
    setCreating(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newUser, groups: newUserGroups }),
      });
      if (res.ok) {
        addToast('success', 'User created', `User "${newUser.id}" created successfully`);
        setShowCreateUser(false);
        setNewUser({ id: '', email: '', displayName: '', firstName: '', lastName: '' });
        setNewUserGroups([]);
        fetchData();
      } else {
        const data = await res.json();
        addToast('error', 'Failed', data.error);
      }
    } catch {
      addToast('error', 'Error', 'Failed to create user');
    }
    setCreating(false);
  };

  const handleCreateGroup = async () => {
    if (!newGroupName) return;
    try {
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGroupName }),
      });
      if (res.ok) {
        addToast('success', 'Group created', `Group "${newGroupName}" created`);
        setShowCreateGroup(false);
        setNewGroupName('');
        fetchData();
      } else {
        const data = await res.json();
        addToast('error', 'Failed', data.error);
      }
    } catch {
      addToast('error', 'Error', 'Failed to create group');
    }
  };

  const handleDelete = async () => {
    if (!deleteModal) return;
    try {
      const res = await fetch(deleteModal.type === 'user' ? '/api/users' : '/api/groups', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          deleteModal.type === 'user' ? { userId: deleteModal.id } : { groupId: deleteModal.id }
        ),
      });
      if (res.ok) {
        addToast('success', 'Deleted', `${deleteModal.type === 'user' ? 'User' : 'Group'} "${deleteModal.name}" deleted`);
        fetchData();
      } else {
        const data = await res.json();
        addToast('error', 'Failed', data.error);
      }
    } catch {
      addToast('error', 'Error', 'Delete failed');
    }
    setDeleteModal(null);
  };

  const handleGroupMembership = async (userId: string, groupId: number, action: 'add' | 'remove') => {
    try {
      const res = await fetch('/api/groups', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, userId, groupId }),
      });
      if (res.ok) {
        fetchData();
      } else {
        const data = await res.json();
        addToast('error', 'Failed', data.error);
      }
    } catch {
      addToast('error', 'Error', 'Failed to update group membership');
    }
  };

  if (notConfigured) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Users & Groups" showBack={false} />
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <div className="p-4 bg-gray-100 dark:bg-gray-800 rounded-full w-16 h-16 mx-auto mb-4 flex items-center justify-center">
              <Users size={32} className="text-gray-400" />
            </div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">LDAP Not Configured</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Deploy the LLDAP service and configure LDAP connection in Settings to manage users and groups.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Users & Groups"
        showBack={false}
        actions={
          <button
            onClick={handleSeedGroups}
            className="px-3 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2"
            title="Create default groups (admins, family) if they don't exist"
          >
            <Sprout size={16} />
            <span className="hidden sm:inline">Seed Groups</span>
          </button>
        }
      />

      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
        {([
          { id: 'users' as const, label: 'Users', icon: Users },
          { id: 'groups' as const, label: 'Groups', icon: Shield },
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            <tab.icon size={16} />
            {tab.label}
            <span className="text-xs bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded-full">
              {tab.id === 'users' ? users.length : groups.length}
            </span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        ) : activeTab === 'users' ? (
          <>
            {/* Create User */}
            {showCreateUser ? (
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 space-y-3">
                <h3 className="font-bold text-gray-900 dark:text-white">New User</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    placeholder="Username *"
                    value={newUser.id}
                    onChange={e => setNewUser(prev => ({ ...prev, id: e.target.value }))}
                    className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    placeholder="Email *"
                    type="email"
                    value={newUser.email}
                    onChange={e => setNewUser(prev => ({ ...prev, email: e.target.value }))}
                    className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    placeholder="Display Name"
                    value={newUser.displayName}
                    onChange={e => setNewUser(prev => ({ ...prev, displayName: e.target.value }))}
                    className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    placeholder="First Name"
                    value={newUser.firstName}
                    onChange={e => setNewUser(prev => ({ ...prev, firstName: e.target.value }))}
                    className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    placeholder="Last Name"
                    value={newUser.lastName}
                    onChange={e => setNewUser(prev => ({ ...prev, lastName: e.target.value }))}
                    className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                {groups.length > 0 && (
                  <div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Add to groups:</p>
                    <div className="flex flex-wrap gap-2">
                      {groups.map(g => (
                        <label key={g.id} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                          <input
                            type="checkbox"
                            checked={newUserGroups.includes(g.id)}
                            onChange={e => {
                              setNewUserGroups(prev =>
                                e.target.checked ? [...prev, g.id] : prev.filter(id => id !== g.id)
                              );
                            }}
                            className="rounded border-gray-300 dark:border-gray-600"
                          />
                          {g.displayName}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setShowCreateUser(false)}
                    className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateUser}
                    disabled={!newUser.id || !newUser.email || creating}
                    className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                    Create User
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowCreateUser(true)}
                className="px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
              >
                <Plus size={16} />
                Add User
              </button>
            )}

            {/* Users List */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
              {users.length === 0 ? (
                <div className="p-8 text-center text-gray-500 dark:text-gray-400 text-sm">
                  No users found. Create users via the LLDAP web UI or the form above.
                </div>
              ) : (
                <div className="divide-y divide-gray-100 dark:divide-gray-700">
                  {users.map(user => (
                    <div key={user.id}>
                      <div
                        className="flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                        onClick={() => setExpandedUser(expandedUser === user.id ? null : user.id)}
                      >
                        <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400 font-bold text-sm shrink-0">
                          {(user.displayName || user.id).charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-gray-900 dark:text-white text-sm truncate">
                            {user.displayName || user.id}
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                            {user.id} &middot; {user.email}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {user.groups.map(g => (
                            <span
                              key={g.id}
                              className={`text-xs px-2 py-0.5 rounded-full ${
                                g.displayName === 'admins'
                                  ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                                  : g.displayName === 'family'
                                  ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                              }`}
                            >
                              {g.displayName}
                            </span>
                          ))}
                          {expandedUser === user.id ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                        </div>
                      </div>

                      {/* Expanded: group management */}
                      {expandedUser === user.id && (
                        <div className="px-4 pb-3 pt-1 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-700">
                          <div className="flex flex-wrap items-center gap-2 mb-2">
                            <span className="text-xs text-gray-500 dark:text-gray-400">Groups:</span>
                            {groups.map(g => {
                              const isMember = user.groups.some(ug => ug.id === g.id);
                              return (
                                <button
                                  key={g.id}
                                  onClick={() => handleGroupMembership(user.id, g.id, isMember ? 'remove' : 'add')}
                                  className={`text-xs px-2 py-1 rounded-lg flex items-center gap-1 transition-colors ${
                                    isMember
                                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-700'
                                      : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-green-100 dark:hover:bg-green-900/30 hover:text-green-700'
                                  }`}
                                  title={isMember ? `Remove from ${g.displayName}` : `Add to ${g.displayName}`}
                                >
                                  {isMember ? <UserMinus size={12} /> : <UserPlus size={12} />}
                                  {g.displayName}
                                </button>
                              );
                            })}
                          </div>
                          <div className="flex justify-end">
                            <button
                              onClick={() => setDeleteModal({ type: 'user', id: user.id, name: user.displayName || user.id })}
                              className="text-xs text-red-600 hover:text-red-700 flex items-center gap-1"
                            >
                              <Trash2 size={12} />
                              Delete User
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Create Group */}
            {showCreateGroup ? (
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 space-y-3">
                <h3 className="font-bold text-gray-900 dark:text-white">New Group</h3>
                <input
                  placeholder="Group name"
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setShowCreateGroup(false); setNewGroupName(''); }}
                    className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateGroup}
                    disabled={!newGroupName}
                    className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  >
                    <Plus size={14} />
                    Create Group
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowCreateGroup(true)}
                className="px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
              >
                <Plus size={16} />
                Add Group
              </button>
            )}

            {/* Groups List */}
            <div className="space-y-4">
              {groups.length === 0 ? (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-8 text-center text-gray-500 dark:text-gray-400 text-sm">
                  No groups found. Click &quot;Seed Groups&quot; to create the default groups.
                </div>
              ) : (
                groups.map(group => (
                  <div key={group.id} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
                    <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${
                        group.displayName === 'admins'
                          ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                          : group.displayName === 'family'
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
                          : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                      }`}>
                        <Shield size={20} />
                      </div>
                      <div className="flex-1">
                        <h3 className="font-bold text-gray-900 dark:text-white">{group.displayName}</h3>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {group.users.length} member{group.users.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                      {group.displayName !== 'admins' && group.displayName !== 'family' && group.displayName !== 'lldap_admin' && (
                        <button
                          onClick={() => setDeleteModal({ type: 'group', id: group.id, name: group.displayName })}
                          className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                          title="Delete group"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                    <div className="p-4">
                      {group.users.length === 0 ? (
                        <p className="text-sm text-gray-400 dark:text-gray-500">No members</p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {group.users.map(u => (
                            <span
                              key={u.id}
                              className="text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-3 py-1 rounded-full"
                            >
                              {u.displayName || u.id}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      <ConfirmModal
        isOpen={!!deleteModal}
        title={`Delete ${deleteModal?.type === 'user' ? 'User' : 'Group'}`}
        message={`Are you sure you want to delete "${deleteModal?.name}"? This action cannot be undone.`}
        confirmText="Delete"
        isDestructive
        onConfirm={handleDelete}
        onCancel={() => setDeleteModal(null)}
      />
    </div>
  );
}
