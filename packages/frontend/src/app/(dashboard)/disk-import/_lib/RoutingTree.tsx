'use client';

// Disk-import — per-folder ROUTING TREE review UI (#2000, epic #1901).
//
// A REAL expandable folder tree (not a flat list of text fields, per the operator):
// each folder shows its file/size rollup and gets an Owner picker (shared / box
// users) + a Target/disposition picker. Edits are INHERITED down the tree, so a
// child reflects its ancestor's pick (shown muted "inherited") until the operator
// sets it explicitly (shown solid). A top-level folder named like a box user is
// auto-assigned to that owner and shown pre-selected. Each folder previews its live
// `data/<owner>/<category>/…` destination. The collected explicit rule map drives
// the re-plan (re-route + re-dedup per owner in the worker) → review → Import.

import { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FileText } from 'lucide-react';
import {
  DISPOSITION_LABELS,
  type Disposition,
  type ReviewNode,
  type ReviewOwner,
  type ReviewTree,
  type Rule,
} from './types';

/** Initial auto-expand depth — show the disk root + its top-level folders. */
const DEFAULT_EXPAND_DEPTH = 2;

/** Bytes → short human size (e.g. "457 GB"). */
function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** i;
  return `${val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

/** Display name of a folder (its last path segment); the root is "Disk root". */
function dirLabel(dir: string): string {
  if (dir === '') return 'Disk root';
  const segs = dir.split('/');
  return segs[segs.length - 1];
}

/** Depth of a dir (root = 0). */
function depthOf(dir: string): number {
  return dir === '' ? 0 : dir.split('/').length;
}

/** A node plus its children, assembled from the flat (sorted) node list. */
interface TreeRow {
  node: ReviewNode;
  children: TreeRow[];
}

/** Build the nested tree from the flat node list (each node knows its full dir). */
function nest(nodes: ReviewNode[]): TreeRow | null {
  const byDir = new Map<string, TreeRow>();
  for (const node of nodes) byDir.set(node.dir, { node, children: [] });
  let root: TreeRow | null = null;
  for (const row of byDir.values()) {
    const dir = row.node.dir;
    if (dir === '') {
      root = row;
      continue;
    }
    const slash = dir.lastIndexOf('/');
    const parentDir = slash === -1 ? '' : dir.slice(0, slash);
    byDir.get(parentDir)?.children.push(row);
  }
  // Stable child order by name.
  for (const row of byDir.values()) {
    row.children.sort((a, b) => (a.node.dir < b.node.dir ? -1 : 1));
  }
  return root;
}

export interface RoutingTreeProps {
  data: ReviewTree;
  /** The current explicit rule map (relDir → edited Rule), controlled by the page. */
  rules: Record<string, Rule>;
  /** Set/clear one folder's axis; the page re-fetches the tree to re-resolve. */
  onSetRule: (dir: string, patch: Rule) => void;
}

/** The routing tree: a real expandable folder tree with owner + target pickers. */
export function RoutingTree({ data, rules, onSetRule }: RoutingTreeProps) {
  const root = useMemo(() => nest(data.tree), [data.tree]);
  // Auto-expand the first couple of levels; the operator drills deeper on demand.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const init = new Set<string>();
    for (const n of data.tree) if (depthOf(n.dir) < DEFAULT_EXPAND_DEPTH) init.add(n.dir);
    return init;
  });
  const toggle = (dir: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  if (!root) return null;
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
      <Row
        row={root}
        data={data}
        rules={rules}
        onSetRule={onSetRule}
        expanded={expanded}
        toggle={toggle}
      />
    </div>
  );
}

function Row({
  row,
  data,
  rules,
  onSetRule,
  expanded,
  toggle,
}: {
  row: TreeRow;
  data: ReviewTree;
  rules: Record<string, Rule>;
  onSetRule: (dir: string, patch: Rule) => void;
  expanded: Set<string>;
  toggle: (dir: string) => void;
}) {
  const { node } = row;
  const isOpen = expanded.has(node.dir);
  const hasChildren = row.children.length > 0;
  const depth = depthOf(node.dir);
  const explicit = rules[node.dir] ?? node.explicit;
  const indent = 8 + depth * 16;

  return (
    <>
      <div
        className="flex items-center gap-2 py-1.5 pr-3 text-xs hover:bg-gray-50 dark:hover:bg-gray-800/40"
        style={{ paddingLeft: `${indent}px` }}
      >
        <button
          onClick={() => hasChildren && toggle(node.dir)}
          className={`shrink-0 ${hasChildren ? 'text-gray-500' : 'invisible'}`}
          aria-label={isOpen ? 'Collapse' : 'Expand'}
        >
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <Folder size={14} className="shrink-0 text-amber-500" />
        <span className="font-medium text-gray-800 dark:text-gray-200 truncate" title={node.dir || '/'}>
          {dirLabel(node.dir)}
        </span>
        {node.files > 0 && (
          <span className="shrink-0 text-gray-400 tabular-nums">
            {node.files.toLocaleString()} · {fmtBytes(node.bytes)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {node.dir !== '' && (
            <BaseToggle
              active={explicit.base === true}
              onToggle={() => onSetRule(node.dir, { base: !(explicit.base === true) })}
            />
          )}
          <OwnerPicker
            owners={data.owners}
            value={node.resolved.owner}
            explicit={explicit.owner}
            onChange={owner => onSetRule(node.dir, { owner })}
          />
          <TargetPicker
            dispositions={data.dispositions}
            value={node.resolved.disposition}
            explicit={explicit.disposition}
            onChange={disposition => onSetRule(node.dir, { disposition })}
          />
        </div>
      </div>
      <div
        className="flex items-center gap-1.5 pb-1.5 text-[11px] text-gray-400"
        style={{ paddingLeft: `${indent + 22}px` }}
      >
        <FileText size={11} className="shrink-0" />
        <span className="font-mono truncate" title={node.preview}>{node.preview}</span>
      </div>
      {isOpen &&
        row.children.map(child => (
          <Row
            key={child.node.dir}
            row={child}
            data={data}
            rules={rules}
            onSetRule={onSetRule}
            expanded={expanded}
            toggle={toggle}
          />
        ))}
    </>
  );
}

/**
 * "Base root" toggle. When active, this folder's OWN name is dropped and only the
 * structure below it is kept (e.g. mark `backup_2025/` so its contents merge with
 * `backup_2026/`'s at `documents/docs/…`). Off by default; inherited folders keep
 * their full path.
 */
function BaseToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={
        active
          ? "Base root — this folder's name is dropped; the structure below it is kept"
          : "Mark as a base/backup root — drop this folder's name, keep what's inside"
      }
      className={`rounded border px-1.5 py-0.5 text-[11px] ${
        active
          ? 'bg-blue-600 text-white border-blue-600 font-medium'
          : 'bg-white dark:bg-gray-900 text-gray-400 border-gray-200 dark:border-gray-700 hover:text-gray-600 dark:hover:text-gray-300'
      }`}
    >
      strip
    </button>
  );
}

/** Owner dropdown. Muted when the value is inherited (not set on this node). */
function OwnerPicker({
  owners,
  value,
  explicit,
  onChange,
}: {
  owners: ReviewOwner[];
  value: string;
  explicit?: string;
  onChange: (owner: string) => void;
}) {
  const inherited = explicit === undefined;
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      title={inherited ? 'Inherited — pick to set explicitly' : 'Set on this folder'}
      className={`rounded border px-1.5 py-0.5 text-[11px] bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 ${
        inherited ? 'text-gray-400 italic' : 'text-gray-800 dark:text-gray-200 font-medium'
      }`}
    >
      {owners.map(o => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Target/disposition dropdown. Muted when inherited. */
function TargetPicker({
  dispositions,
  value,
  explicit,
  onChange,
}: {
  dispositions: Disposition[];
  value: Disposition;
  explicit?: Disposition;
  onChange: (d: Disposition) => void;
}) {
  const inherited = explicit === undefined;
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as Disposition)}
      title={inherited ? 'Inherited — pick to set explicitly' : 'Set on this folder'}
      className={`rounded border px-1.5 py-0.5 text-[11px] bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 ${
        inherited ? 'text-gray-400 italic' : 'text-gray-800 dark:text-gray-200 font-medium'
      }`}
    >
      {dispositions.map(d => (
        <option key={d} value={d}>
          {DISPOSITION_LABELS[d]}
        </option>
      ))}
    </select>
  );
}
