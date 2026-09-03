'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { useTopologyData } from '@/hooks/useTopologyData';
import { NETWORK_FOCUS_PARAM, planDeepLinkFocus } from '@/components/networkFocus';
import type { PortMapping, ServiceUnit } from '@servicebay/api-client';
import { buildServiceViewModel } from '@servicebay/api-client';
import type { ServiceViewModel } from '@servicebay/api-client';
import { useServiceActions } from '@/hooks/useServiceActions';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import ServiceDetailSummary from '@/components/serviceDetail/ServiceDetailSummary';
import { createNetworkEdge, deleteNetworkEdge, updateExternalLink } from '@servicebay/api-client';

import { 
  ReactFlow, 
  Background, 
  Controls, 
  MiniMap, 
  useNodesState, 
  useEdgesState,
  Node,
  Edge,
  Connection,
  addEdge,
  Panel,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getLayoutedElements } from '@servicebay/api-client';
import { X, Trash2, Edit, Info, Globe, FileText, Activity, Link as LinkIcon, ArrowRight, ArrowLeft } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { useToast } from '@/providers/ToastProvider';
import ExternalLinkModal from '@/components/ExternalLinkModal';
import { Button, Badge, StatusDot, Input, Search, SEARCH_SLOT_CLASS } from '@/components/ui';
import {
  buildServiceEditHref,
  computeEgoNodeIds,
  DEFAULT_EDGE_COLOR,
  DOWN_EDGE_COLOR,
  DOWN_EDGE_DASHES,
  deriveNodeNameFromGraph,
  labelForEdgeKind,
  mergeGraphPreservingPositions,
  styleForEdgeKind,
  topologyLayoutSignature,
  type GraphNodeData,
  type HealthData,
  type LegacyPortMapping,
} from './_lib/networkDashboard';
import type { ReactFlowInstance } from '@xyflow/react';
import { CustomEdge } from './_lib/NetworkGraphEdge';
import { CustomNode } from './_lib/NetworkGraphNode';
import { getMiniMapNodeColor, getMiniMapStrokeColor, NetworkLegend } from './_lib/NetworkLegend';


const nodeTypes = {
  custom: CustomNode,
};

const edgeTypes = {
  custom: CustomEdge,
};

// Edge-kind styling constants and helpers moved to
// `./_lib/networkDashboard.ts` in #961's first decomposition step.
// `styleForEdgeKind`, `labelForEdgeKind`, the edge-color tokens, and
// the DOWN/DECLARED/OBSERVED palette all live in that module now.

type LinkFormState = {
    name: string;
    url: string;
    description: string;
    monitor: boolean;
    ipTargetsText?: string;
};


export default function NetworkDashboard() {
    const router = useRouter();
    const searchParams = useSearchParams();
    // #2108 — `?focus=<service-name>` from the Services list jumps here with a
    // service to centre. We resolve it to a graph node id (handling the remote
    // `<node>:` prefix) once the graph has loaded, and apply each distinct
    // param value exactly once so a manual click / Back doesn't get clobbered
    // on re-render.
    const focusParam = searchParams.get(NETWORK_FOCUS_PARAM);
    const appliedFocusParamRef = useRef<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<GraphNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [searchQuery, setSearchQuery] = useState('');
  // Focus / ego mode (#1786): the id of the node whose neighbourhood the
  // map is reduced to. `null` ⇒ full map. Clicking a node enters focus;
  // clicking the canvas, the Back control, or Esc exits it.
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const reactFlowInstance = useRef<ReactFlowInstance<Node<GraphNodeData>, Edge> | null>(null);
  const [selectedNodeData, setSelectedNodeData] = useState<GraphNodeData | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const rawGraphData = React.useRef<{ nodes: Node[], edges: Edge[] } | null>(null);
  // #2119 — the topology signature (node ids + edge ids + collapsed set +
  // focus) of the currently laid-out graph, and a snapshot of that laid-out
  // graph. A poll whose signature is unchanged does NOT re-run ELK or reset the
  // viewport — it merges fresh status/health onto the existing positions. We
  // fitView only on the FIRST layout and on a focus change (intentional camera
  // moves), never on a steady-state refresh.
  const layoutSignatureRef = React.useRef<string | null>(null);
  const laidOutGraphRef = React.useRef<{ nodes: Node<GraphNodeData>[]; edges: Edge[] } | null>(null);
  const hasFitViewRef = React.useRef(false);
    // #2195 — `activeToastRef` now only tracks a toast owned by an EXPLICIT
    // network scan (the `network-scan-progress` SSE below opens/updates it).
    // The steady-state twin-driven auto-refresh no longer creates one: a
    // background fetch is silent, so a flurry of status/metric twin updates
    // never stacks a "Refreshing Network" toast and makes the UI restless.
    const activeToastRef = React.useRef<string | null>(null);
    const { addToast, updateToast } = useToast();

  // #2195 — surface a refresh indicator ONLY when the topology actually
  // changed (a full re-layout). It is brief and non-sticky (auto-dismisses),
  // never a duration-0 sticky loop. The in-place status/metric merge path
  // (topology signature unchanged) calls neither of these — it stays silent.
  const NETWORK_UPDATED_TOAST_MS = 2500;
  const notifyTopologyChanged = useCallback(() => {
      // If an explicit scan is showing a loading toast, resolve it in place
      // instead of stacking a second toast on top.
      if (activeToastRef.current) {
          updateToast(activeToastRef.current, 'success', 'Network updated', 'Topology changed', NETWORK_UPDATED_TOAST_MS);
          activeToastRef.current = null;
          return;
      }
      addToast('info', 'Network updated', undefined, NETWORK_UPDATED_TOAST_MS);
  }, [addToast, updateToast]);

  const notifyRefreshError = useCallback((description?: string) => {
      if (activeToastRef.current) {
          updateToast(activeToastRef.current, 'error', 'Network refresh failed', description);
          activeToastRef.current = null;
          return;
      }
      addToast('error', 'Network refresh failed', description);
  }, [addToast, updateToast]);

  // Health Modal State
  const [showHealthModal, setShowHealthModal] = useState(false);
  const [healthData, setHealthData] = useState<HealthData | null>(null);

  // Link Modal State
  const [showLinkModal, setShowLinkModal] = useState(false);
    const [linkForm, setLinkForm] = useState<LinkFormState>({ name: '', url: '', description: '', monitor: false, ipTargetsText: '' });

  // Connection Modal State
  const [showConnectionModal, setShowConnectionModal] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null);
  const [connectionPort, setConnectionPort] = useState('');
  const [availablePorts, setAvailablePorts] = useState<number[]>([]);
    const selectedEdgeDetails = useMemo(() => {
        if (!selectedEdge) return null;
        return edges.find(edge => edge.id === selectedEdge) || null;
    }, [edges, selectedEdge]);
    const selectedEdgeMeta = selectedEdgeDetails?.data as { isManual?: boolean; state?: string; port?: number } | undefined;

  const onConnect = useCallback(
    (params: Connection) => {
        setPendingConnection(params);
        setConnectionPort('');
        
        // Find target node to get available ports
        const targetNode = nodes.find(n => n.id === params.target);
        const rawData = targetNode?.data?.rawData;
        if (targetNode && rawData?.ports && Array.isArray(rawData.ports)) {
            // Extract ports (handle both number and object format)
            const ports = (rawData.ports as unknown[]).map((p) => {
                if (typeof p === 'object' && p !== null) {
                    const portMap = p as LegacyPortMapping;
                    return portMap.hostPort || portMap.host || portMap.containerPort || portMap.container;
                }
                return p as number;
            }).filter((p) => Number(p) > 0) as number[];
            setAvailablePorts(ports);
            // If there's only one port, pre-select it? No, user might want generic link.
            // But user asked for default to be that port.
            if (ports.length > 0) {
                setConnectionPort(ports[0].toString());
            }
        } else {
            setAvailablePorts([]);
        }

        setShowConnectionModal(true);
    },
    [nodes]
  );

  const handleSaveConnection = async () => {
      if (!pendingConnection) return;

      // Optimistic update
      setEdges((eds) => addEdge(pendingConnection, eds));
      setShowConnectionModal(false);
      
      try {
        await createNetworkEdge({
            source: pendingConnection.source,
            target: pendingConnection.target,
            type: 'manual',
            port: connectionPort
        });

        addToast('success', 'Connection created');
        fetchGraph(); // Rerender layout
      } catch {
        addToast('error', 'Failed to create connection');
        fetchGraph(); // Revert on error
      }
  };

  // Extract helper: check if query matches basic node fields
  const checkBasicNodeFields = (data: GraphNodeData, q: string): boolean => {
    if (data.label && String(data.label).toLowerCase().includes(q)) return true;
    if (data.subLabel && String(data.subLabel).toLowerCase().includes(q)) return true;
    if (data.hostname && String(data.hostname).toLowerCase().includes(q)) return true;
    return false;
  };

  // Extract helper: check if query matches port mappings
  const checkNodePorts = (ports: unknown[] | undefined, q: string): boolean => {
    if (!ports || !Array.isArray(ports)) return false;
    const portsStr = (ports as unknown[]).map((p) => {
      if (typeof p === 'object' && p !== null) {
        const pm = p as LegacyPortMapping;
        return `${pm.host || pm.hostPort} ${pm.container || pm.containerPort}`;
      }
      return String(p);
    }).join(' ');
    return portsStr.includes(q);
  };

  // Extract helper: check if query matches raw data fields
  const checkRawDataFields = (raw: Record<string, unknown>, q: string): boolean => {
    if (raw.url && String(raw.url).toLowerCase().includes(q)) return true;
    if (raw.externalIP && String(raw.externalIP).includes(q)) return true;
    if (raw.internalIP && String(raw.internalIP).includes(q)) return true;
    return false;
  };

  // Extract helper: check if query matches verified domains
  const checkVerifiedDomains = (verifiedDomains: unknown, q: string): boolean => {
    if (!Array.isArray(verifiedDomains)) return false;
    return verifiedDomains.some((d: string) => d.toLowerCase().includes(q));
  };

  const matchesSearch = useCallback((node: Node<GraphNodeData>, query: string) => {
    if (!query) return true;
    const q = query.toLowerCase();
    const data = node.data;
    const raw = data.rawData || {};

    if (checkBasicNodeFields(data, q)) return true;
    if (checkNodePorts(data.rawData?.ports, q)) return true;
    if (checkRawDataFields(raw as Record<string, unknown>, q)) return true;
    if (checkVerifiedDomains(data.metadata?.verifiedDomains, q)) return true;

    return false;
  }, []);

  const applyFilter = useCallback((nodesToFilter: Node<GraphNodeData>[], query: string) => {
    return nodesToFilter.map(node => {
        const isMatch = matchesSearch(node, query);
        const targetOpacity = isMatch ? 1 : 0.2;
        const targetFilter = isMatch ? 'none' : 'grayscale(100%)';
        
        if (node.style?.opacity === targetOpacity && node.style?.filter === targetFilter) {
            return node;
        }

        return {
            ...node,
            style: {
                ...node.style,
                opacity: targetOpacity,
                filter: targetFilter,
                transition: 'all 0.3s ease'
            }
        };
    });
  }, [matchesSearch]);

  const searchQueryRef = React.useRef(searchQuery);
  useEffect(() => {
      searchQueryRef.current = searchQuery;
      setNodes((nds) => applyFilter(nds, searchQuery));
  }, [searchQuery, applyFilter, setNodes]);

  // #2630 — `isStale` is the caller's run-generation guard. ELK resolves
  // asynchronously with no guaranteed ordering, so a superseded run must be
  // able to abandon its commit; see the check after the await below.
  const processAndLayout = useCallback(async (nodes: Node<GraphNodeData>[], edges: Edge[], collapsed: Set<string>, search: string, focus: string | null = null, isStale: () => boolean = () => false) => {
    // 1. Prepare Nodes (Aggregation & toggles)
     
    const processedNodes = nodes.map(node => {
           if (['group', 'service', 'pod', 'proxy', 'unmanaged-service'].includes(node.data.type)) {
               const isCollapsed = collapsed.has(node.id);
             
             // Aggregate Summary
              
             const children = nodes.filter(n => n.parentId === node.id);
             let status = 'up';
             if (children.some(c => c.data.status === 'down')) status = 'down';
             
             const verifiedDomains = Array.from(new Set(children.flatMap(c => c.data.metadata?.verifiedDomains || []) as string[]));
             const portMap = children.flatMap(c => c.data.rawData?.ports || []).map((p) => {
                 if (typeof p === 'object' && p !== null) return p;
                 return { hostPort: Number(p), containerPort: Number(p), protocol: 'tcp' } as PortMapping;
             });
             
             return {
                 ...node,
                 data: {
                     ...node.data,
                     collapsed: isCollapsed,
                     summary: {
                         status,
                         verifiedDomains,
                         portMap
                     },
                     onToggle: (id: string) => {
                         setCollapsedGroups(prev => {
                             const next = new Set(prev);
                             if (next.has(id)) next.delete(id);
                             else next.add(id);
                             return next;
                         });
                     }
                 },
                 // Only remove dimensions for actual group containers so card nodes keep auto height
                 style: (isCollapsed && node.data.type === 'group')
                     ? { ...node.style, width: undefined, height: undefined }
                     : node.style
             };
        }
        return node;
    });

    // 2. Filter hidden nodes
    // Filter out any node whose parent is collapsed
    const visibleNodes = processedNodes.map(node => {
        if (node.data?.type === 'proxy' && node.style?.height !== undefined) {
            return {
                ...node,
                style: {
                    ...node.style,
                    height: undefined
                }
            };
        }
        return node;
    }).filter(n => !n.parentId || !collapsed.has(n.parentId));
    const visibleNodeIds = new Set(visibleNodes.map(n => n.id));

    // 3. Process Edges (Redirect edges from hidden children to their collapsed parent)
    const edgeSignatures = new Set<string>();
    const visibleEdges: Edge[] = [];

    // Helper to find the visible representative for a node (itself or its parent)
    const getVisibleId = (id: string): string | null => {
        if (visibleNodeIds.has(id)) return id;
        const node = nodes.find(n => n.id === id);
        if (node && node.parentId && visibleNodeIds.has(node.parentId)) {
            return node.parentId;
        }
        return null;
    };

    edges.forEach(e => {
        const source = getVisibleId(e.source);
        const target = getVisibleId(e.target);

        // If either end is not resolvable to a visible node, skip
        if (!source || !target) return;

        // Skip self-loops (edges completely inside a collapsed group)
        if (source === target) return;

        // Deduplicate edges (e.g. multiple children connecting to same target)
        const signature = `${source}->${target}`;
        if (edgeSignatures.has(signature)) return;
        edgeSignatures.add(signature);

        const originalId = (e.data as { originalId?: string })?.originalId || e.id;

        visibleEdges.push({
            ...e,
            id: `e-${source}-${target}`, // Generate new stable ID for the layout
            source,
            target,
            data: {
                ...e.data,
                originalId
            }
        });
    });
    
    // 3b. Focus / ego mode (#1786). Reduce the visible graph to the
    // focus node's neighbourhood + the Internet→focus path before
    // layout, so ELK lays out only the relevant subgraph (crossing-free)
    // and `fitView` zooms to it. Child nodes of a kept group are kept
    // too so expanded groups don't lose their members.
    let layoutNodes = visibleNodes;
    let layoutEdges = visibleEdges;
    if (focus) {
        const ego = computeEgoNodeIds(visibleNodes, visibleEdges, focus);
        if (ego.size > 0) {
            const keep = (n: Node<GraphNodeData>) => ego.has(n.id) || (n.parentId ? ego.has(n.parentId) : false);
            layoutNodes = visibleNodes.filter(keep);
            const keptIds = new Set(layoutNodes.map(n => n.id));
            layoutEdges = visibleEdges.filter(e => keptIds.has(e.source) && keptIds.has(e.target));
        }
    }

    // 4. Layout
    // #2198 — getLayoutedElements now stamps each child leaf's ELK-computed
    // box (width + height) directly, so the #2194 applyChildSlotHeights
    // band-aid is gone; the child card renders `h-full` to fill that slot.
    const layouted = await getLayoutedElements(layoutNodes, layoutEdges);
    // #2630 — bail out BEFORE committing when a newer run has started. The
    // layout promise has no guaranteed resolution order, so two topology
    // changes close together (a collapse toggle landing next to a twin-driven
    // poll) can resolve out of order; without this the older run's
    // setNodes/setEdges/laidOutGraphRef write silently overwrote the newer
    // topology and the map snapped back to a stale arrangement.
    if (isStale()) return;
    const filteredNodes = applyFilter(layouted.nodes as Node<GraphNodeData>[], search);
    const layoutedEdges = layouted.edges;
    setNodes(filteredNodes);
    setEdges(layoutedEdges);
    // #2119 — snapshot the laid-out graph so a subsequent identical-topology
    // poll can merge fresh status/health onto these positions in-place
    // (no ELK, no viewport reset).
    laidOutGraphRef.current = { nodes: filteredNodes, edges: layoutedEdges };

    // #2119 — fit the viewport only on the FIRST layout (empty → first data)
    // and on a focus change (the #2108 ego-action is an intentional camera
    // move). Steady-state polls never reach here, so the pan/zoom is preserved.
    if (focus) {
        requestAnimationFrame(() => {
            reactFlowInstance.current?.fitView({ padding: 0.2, duration: 400 });
        });
    } else if (!hasFitViewRef.current) {
        hasFitViewRef.current = true;
        requestAnimationFrame(() => {
            reactFlowInstance.current?.fitView({ padding: 0.18, minZoom: 0.7, maxZoom: 1.2 });
        });
    }
  }, [setNodes, setEdges, applyFilter]);

  // #2119 — identical-topology poll path: merge the fresh status/health data
  // onto the already-laid-out positions and re-apply the search filter, without
  // running ELK or touching the viewport. Requires a prior laid-out snapshot.
  const mergeInPlace = useCallback((freshNodes: Node<GraphNodeData>[], freshEdges: Edge[], search: string) => {
      const prev = laidOutGraphRef.current;
      if (!prev) return;
      const merged = mergeGraphPreservingPositions(prev.nodes, prev.edges, freshNodes, freshEdges);
      const filtered = applyFilter(merged.nodes, search);
      laidOutGraphRef.current = { nodes: filtered, edges: merged.edges };
      setNodes(filtered);
      setEdges(merged.edges);
  }, [applyFilter, setNodes, setEdges]);

  // #2119 — run-generation guard: each layout effect bumps this; an async
  // pass only commits its focus/toast if it's still the latest run.
  const layoutRunRef = React.useRef(0);

  // #2119 — apply a fresh topology: merge in place when the signature is
  // unchanged (no ELK, no viewport reset), else re-layout. #2108 — commit the
  // resolved deep-link focus to state from the async callback so Back/Esc
  // reflect it. Extracted from the effect to keep both under the size budget.
  const applyTopology = useCallback(async (
      gd: { nodes: Node<GraphNodeData>[]; edges: Edge[] },
      currentCollapsed: Set<string>,
      currentFocus: string | null,
      signature: string,
      focusPlan: ReturnType<typeof planDeepLinkFocus>,
      runId: number,
  ) => {
      const topologyUnchanged =
          layoutSignatureRef.current === signature && laidOutGraphRef.current !== null;
      const hasFreshDeepLinkFocus = Boolean(focusPlan.appliedParam && focusPlan.nodeId);
      // #2195 — the FIRST layout (no prior signature) is the map appearing, not
      // a change; don't announce it. Only a subsequent topology change (a
      // re-layout with a prior signature) surfaces the brief indicator.
      const isFirstLayout = layoutSignatureRef.current === null;
      const isStale = () => layoutRunRef.current !== runId;
      try {
          if (topologyUnchanged && !hasFreshDeepLinkFocus) {
              // #2195 — background status/metric merge: the map updates in place
              // and stays SILENT (no loading toast, no success toast).
              mergeInPlace(gd.nodes, gd.edges, searchQuery);
              return;
          }
          await processAndLayout(gd.nodes, gd.edges, currentCollapsed, searchQuery, currentFocus, isStale);
          // #2630 — the signature describes what was COMMITTED. A superseded
          // run commits nothing, so it must not stamp its signature either;
          // doing so would make the next identical-topology poll merge in
          // place onto a graph that was never laid out.
          if (isStale()) return;
          layoutSignatureRef.current = signature;
          if (focusPlan.appliedParam && focusPlan.nodeId) {
              appliedFocusParamRef.current = focusPlan.appliedParam;
              setFocusNodeId(focusPlan.nodeId);
          }
          // #2195 — a real topology change re-laid the map out: surface a brief,
          // non-sticky indicator (skip the initial appear + deep-link camera move).
          if (!isFirstLayout && !hasFreshDeepLinkFocus) notifyTopologyChanged();
      } catch {
          if (!isStale()) notifyRefreshError('Unable to render network map');
      }
  }, [mergeInPlace, processAndLayout, searchQuery, notifyTopologyChanged, notifyRefreshError, setFocusNodeId]);

  // #1071 phase 1: data layer (graph fetch + twin-driven auto-refresh
  // + the two effects that drive them) is in useTopologyData. Toast
  // plumbing stays here since it's a UI concern.
  const { rawData, fetchGraph, twin } = useTopologyData({
    onLoadError: (message) => notifyRefreshError(message),
  });

  // The service-action overlays (start/stop/restart/delete modals) still mount
  // so deletions triggered elsewhere resolve cleanly; the per-service controls
  // that used to open them moved to the shared ServiceDetailSummary → Operate
  // page (IA slice 1, #2029).
  const { overlays: serviceActionOverlays } = useServiceActions({ onRefresh: fetchGraph });

  // const refreshing = false; // Hidden

  const handleCreateExternalLink = useCallback((nodeData: GraphNodeData) => {
    if (!nodeData) return;
    const { externalTargetIp, externalTargetPort } = nodeData.metadata || {};
    const rawName = nodeData.rawData?.name || 'External Service';

    // Pre-fill form
    setLinkForm({
        name: rawName,
        url: externalTargetIp ? `http://${externalTargetIp}:${externalTargetPort}` : '',
        description: `Imported from Nginx proxy target ${externalTargetIp}:${externalTargetPort}`,
        monitor: true,
                ipTargetsText: externalTargetIp || ''
    });
    setShowLinkModal(true);
  }, []);

  const graphData = useMemo(() => {
      if (!rawData) return null;
      
      const nodeStatusMap = new Map<string, string | undefined>();
      rawData.nodes.forEach((node) => {
          nodeStatusMap.set(node.id, node.status as string | undefined);
      });

      const coerceStrokeWidth = (value: unknown): number => {
          if (typeof value === 'number' && Number.isFinite(value)) return value;
          if (typeof value === 'string') {
              const parsed = parseFloat(value);
              if (Number.isFinite(parsed)) return parsed;
          }
          return 2;
      };

      const flowNodes: Node<GraphNodeData>[] = rawData.nodes.map((n) => {
        const isGroup = n.type === 'group';
        
        return {
            id: n.id,
            type: 'custom', // Use our custom node
            position: { x: 0, y: 0 }, // Initial position, will be set by ELK
            data: {
                ...n,
                label: n.label,
                type: n.type,
                status: n.status,
                subLabel: n.subLabel ?? undefined,
                hostname: n.hostname ?? undefined,
                ip: n.ip ?? undefined,
                rawData: n.rawData,
                metadata: n.metadata,
                onCreateExternalLink: handleCreateExternalLink
            },
            parentId: n.parentNode,
            extent: n.parentNode ? 'parent' : undefined,
            className: isGroup ? 'border border-dashed border-border bg-surface-2/5 rounded-2xl backdrop-blur-[2px]' : undefined,
            // #2201 — React Flow v12 reads layout dims from top-level
            // width/height, not style. Set the initial group guess top-level so
            // it doesn't fight the top-level dims getLayoutedElements stamps.
            ...(isGroup ? { width: 400, height: 200 } : {}),
            style: isGroup ? {
                width: 400, // Initial guess, ELK will resize
                height: 200,
            } : undefined
        };
      });

      const flowEdges: Edge[] = rawData.edges.map((e) => {
        const fallbackLabel = Number.isFinite(e.port) && e.port > 0 ? `:${e.port}` : undefined;
        const targetStatus = nodeStatusMap.get(e.target);
        const connectsToDownNode = targetStatus === 'down';
        const baseStyle = e.style as React.CSSProperties | undefined;
        // Down-target styling (red dashed) takes priority over kind
        // styling — a broken target is more urgent than provenance. (#813)
        const edgeStyle = connectsToDownNode
            ? {
                ...(baseStyle || {}),
                stroke: DOWN_EDGE_COLOR,
                strokeWidth: Math.max(2, coerceStrokeWidth(baseStyle?.strokeWidth)),
                strokeDasharray: DOWN_EDGE_DASHES
            }
            : styleForEdgeKind(e.kind, baseStyle);

        const rawLabel = e.label ?? fallbackLabel;
        const decoratedLabel = labelForEdgeKind(e.kind, rawLabel);

        return {
            id: e.id,
            source: e.source,
            target: e.target,
            label: decoratedLabel,
            // #1782 — `custom` edge renders ELK's orthogonal points (attached
            // by getLayoutedElements) as a 90° polyline; falls back to
            // smoothstep until the layout pass routes it.
            type: 'custom',
            markerEnd: {
                type: MarkerType.ArrowClosed,
            },
            style: edgeStyle,
            data: {
                isManual: e.isManual,
                state: e.state,
                port: e.port,
                kind: e.kind,
                // Provenance text used by the edge inspector / tooltip
                // when the operator clicks a `declared` edge to confirm
                // it's an annotation, not observed traffic. (#813)
                tooltip: e.kind === 'declared'
                    ? 'Declared dependency — not observed traffic'
                    : e.kind === 'observed'
                        ? `Observed TCP flow${Number.isFinite(e.port) && e.port > 0 ? ` to :${e.port}` : ''}`
                        : e.kind === 'inferred'
                            ? 'Inferred from env / host — not observed traffic'
                            : undefined,
            },
            animated: connectsToDownNode ? true : e.state === 'active'
        };
      });
      
      return { nodes: flowNodes, edges: flowEdges };
  }, [rawData, handleCreateExternalLink]);

  // #2108 — apply the `?focus=` deep-link once the graph nodes exist. Resolving
  // against the live node ids handles both local (`service-x`) and remote
  // (`box2:service-x`) forms without the linking page reconstructing the prefix.
  const selectedNodeName = useMemo(() => deriveNodeNameFromGraph(selectedNodeData), [selectedNodeData]);

  const selectedServiceViewModel = useMemo<ServiceViewModel | null>(() => {
      if (!selectedNodeData || selectedNodeData.type !== 'service') return null;
      if (!selectedNodeData.rawData) return null;
      if (!selectedNodeName) return null;
      const nodeState = twin?.nodes?.[selectedNodeName];
      if (!nodeState) return null;

      try {
          return buildServiceViewModel({
              unit: selectedNodeData.rawData as ServiceUnit,
              nodeName: selectedNodeName,
              nodeState,
              installedTemplates: twin?.installedTemplates,
          });
      } catch {
          return null;
      }
  }, [selectedNodeData, selectedNodeName, twin]);



  useEffect(() => {
      if (!graphData) return;

      // currentFocus = the live focus state unless a fresh `?focus=` deep-link
      // resolves below (its setState isn't visible until the next render).
      let currentCollapsed = collapsedGroups;
      let currentFocus = focusNodeId;
      if (!rawGraphData.current && graphData.nodes.length > 0) {
                  const groups = graphData.nodes
                      .filter(n => ['group', 'service', 'pod', 'proxy', 'unmanaged-service'].includes(n.data.type as string))
                      .map(n => n.id);
              currentCollapsed = new Set(groups);
              setCollapsedGroups(currentCollapsed);
      }

      // #2108 — resolve the `?focus=` deep-link to a concrete node id, applied
      // once per distinct param (ref-guard) so a manual click / Back isn't
      // clobbered when this effect re-runs.
      const focusPlan = planDeepLinkFocus(
          graphData.nodes.map(n => n.id),
          focusParam,
          appliedFocusParamRef.current,
      );
      if (focusPlan.clearApplied) appliedFocusParamRef.current = null;
      if (focusPlan.nodeId) currentFocus = focusPlan.nodeId;

      rawGraphData.current = graphData;

      // #2119 — signature folds the node/edge ids + collapsed set + focus
      // (everything that moves POSITIONS); status/health/label are excluded, so
      // a steady-state poll keeps the same signature → merge in place.
      const signature = topologyLayoutSignature(
          graphData.nodes,
          graphData.edges,
          currentCollapsed,
          currentFocus,
      );
      const runId = ++layoutRunRef.current;
      applyTopology(graphData, currentCollapsed, currentFocus, signature, focusPlan, runId);
  }, [graphData, applyTopology, collapsedGroups, focusNodeId, focusParam]);

  useEffect(() => {
    // Setup SSE for progress updates
    const eventSource = new EventSource('/api/stream');
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'network-scan-progress' && activeToastRef.current) {
           updateToast(activeToastRef.current, 'loading', 'Refreshing Network', data.message);
        }
      } catch (e) {
        console.error('Error parsing SSE message', e);
      }
    };

    return () => {
      eventSource.close();
    };
  }, [updateToast]);

        const closeNodeDetails = useCallback(() => {
            setSelectedNodeData(null);
        }, []);

        const closeEdgeDetails = useCallback(() => {
            setSelectedEdge(null);
        }, []);

        // Exit focus/ego mode (#1786): restore the full map. Used by the
        // Back control, a canvas (pane) click, and Esc.
        const exitFocus = useCallback(() => {
            setFocusNodeId(null);
        }, []);

        useEscapeKey(closeNodeDetails, Boolean(selectedNodeData), true);
        useEscapeKey(closeEdgeDetails, Boolean(selectedEdge), true);
        // Esc exits focus only when no overlay panel is open above it
        // (the panels' own Esc handlers take precedence via topMostOnly).
        useEscapeKey(exitFocus, Boolean(focusNodeId) && !selectedNodeData && !selectedEdge, true);

  const handleEditLink = () => {
      if (!selectedNodeData || !selectedNodeData.rawData) return;
      const { name, url, description, monitor, ipTargets } = selectedNodeData.rawData;
      const targetsArray = Array.isArray(ipTargets) ? ipTargets : [];
      
      setLinkForm({
          name: name || '',
          url: url || '',
          description: description || '',
          monitor: monitor || false,
          ipTargetsText: targetsArray.join(', ')
      });
      setShowLinkModal(true);
  };

  const handleSaveLink = async () => {
    if (!linkForm.name || !linkForm.url) {
        addToast('error', 'Name and URL are required');
        return;
    }

    try {
        const ipTargets = linkForm.ipTargetsText 
            ? linkForm.ipTargetsText.split(',').map(s => s.trim()).filter(Boolean) 
            : [];

        await updateExternalLink(linkForm.name, {
            url: linkForm.url,
            description: linkForm.description,
            monitor: linkForm.monitor,
            ipTargets,
            type: 'link'
        });

        addToast('success', 'Link updated successfully');
        setShowLinkModal(false);
        setLinkForm({ name: '', url: '', description: '', monitor: false, ipTargetsText: '' });
        fetchGraph(); 
        
        if (selectedNodeData && selectedNodeData.rawData && selectedNodeData.rawData.name === linkForm.name) {
             setSelectedNodeData({
                 ...selectedNodeData,
                 rawData: {
                     ...selectedNodeData.rawData,
                     url: linkForm.url,
                     description: linkForm.description,
                     monitor: linkForm.monitor,
                     ipTargets
                 }
             });
        }
    } catch {
        addToast('error', 'Failed to update link');
    }
  };

  const handleNavigateToBundleMigration = useCallback((node: GraphNodeData) => {
      if (!node) return;
      const metadataId = typeof node.metadata?.bundleId === 'string' ? node.metadata.bundleId : undefined;
      const rawId = typeof node.rawData?.id === 'string' ? node.rawData.id : undefined;
      const fallbackId = typeof node.id === 'string' && node.id.includes('bundle-')
          ? node.id.slice(node.id.lastIndexOf('bundle-') + 'bundle-'.length)
          : undefined;
      const bundleId = metadataId || rawId || fallbackId;

      if (!bundleId) {
          addToast('error', 'Unable to locate bundle metadata');
          return;
      }

      const params = new URLSearchParams({ bundle: bundleId });
      const nodeContext = deriveNodeNameFromGraph(node) || selectedNodeName;
      if (nodeContext) {
          params.set('bundleNode', nodeContext);
      }

      setSelectedNodeData(null);
      router.push(`/services?${params.toString()}`);
  }, [addToast, router, selectedNodeName]);

  const handleDeleteEdge = async () => {
      if (!selectedEdge) return;
      const edgeInfo = edges.find(edge => edge.id === selectedEdge);
      if (!(edgeInfo?.data as { isManual?: boolean })?.isManual) {
          addToast('error', 'Only manual connections can be removed');
          return;
      }
      const originalId = (edgeInfo?.data as { originalId?: string })?.originalId || selectedEdge;
      try {
          await deleteNetworkEdge(originalId);
          addToast('success', 'Connection removed');
          setSelectedEdge(null);
          fetchGraph();
      } catch {
          addToast('error', 'Failed to remove connection');
      }
  };

  return (
    <div className="h-full flex flex-col">
      <PageHeader 
        title="Map" 
        showBack={false} 
        helpId="network"
      >
        <Search
            label="Search the map"
            value={searchQuery}
            onChange={setSearchQuery}
            className={SEARCH_SLOT_CLASS}
        />
      </PageHeader>

      <div className="flex-1 bg-surface-muted border-t border-border relative overflow-hidden">
        <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            // #2119 — fitView is driven imperatively (first layout + #2108 focus
            // only). The declarative `fitView` prop refits whenever the node set
            // changes, which would reset the viewport on every poll.
            fitViewOptions={{ padding: 0.18, minZoom: 0.7, maxZoom: 1.2 }}
            minZoom={0.1}
            maxZoom={2}
            defaultEdgeOptions={{
                type: 'custom',
                animated: true,
                style: { stroke: DEFAULT_EDGE_COLOR, strokeWidth: 2 },
            }}
            onInit={(instance) => { reactFlowInstance.current = instance; }}
            onNodeClick={(_, node) => {
                // Click = focus the node's neighbourhood (#1786) AND open
                // its details. Clicking a neighbour re-focuses on it.
                setSelectedNodeData(node.data);
                setSelectedEdge(null);
                setFocusNodeId(node.id);
            }}
            onEdgeClick={(_, edge) => {
                setSelectedEdge(edge.id);
                setSelectedNodeData(null);
            }}
            onPaneClick={() => {
                // Clicking empty canvas exits focus mode back to the full map.
                if (focusNodeId) setFocusNodeId(null);
            }}
        >
            {focusNodeId && (
                <Panel position="top-left">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={exitFocus}
                        data-testid="focus-back"
                        className="shadow-sm"
                        title="Back to full map (Esc)"
                    >
                        <ArrowLeft size={14} />
                        Full map
                    </Button>
                </Panel>
            )}
            <NetworkLegend />
            <Background color="var(--text-muted)" gap={16} size={1} className="opacity-10" />
            <Controls
                showInteractive={false}
                className="!bg-surface !border-border shadow-lg [&>button]:!bg-surface [&>button]:!border-border [&>button]:!text-text [&>button:hover]:!bg-surface-2 [&>button>svg]:!fill-current"
            />
            <MiniMap
                className="!bg-surface !border-border shadow-lg scale-50 origin-bottom-right md:scale-100"
                maskColor="transparent"
                nodeStrokeColor={(n) => getMiniMapStrokeColor(n.data?.type as string)}
                nodeColor={(n) => getMiniMapNodeColor(n.data?.type as string)}
            />
            {/* Status-only legend was here; consolidated into the bottom-left
                NetworkLegend (which already covers shape colours + status
                dots). Two side-by-side legend panels were redundant. */}
        </ReactFlow>

      </div>
      
      {/* Health Modal */}
      {showHealthModal && healthData && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-surface border border-border rounded-panel shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
                <div className="flex justify-between items-center p-4 border-b border-border">
                    <div className="flex items-center gap-3">
                        <Activity className="text-accent" />
                        <div>
                            <h3 className="text-lg font-bold text-text">Device Health</h3>
                            <div className="text-xs text-text-muted">Fritz!Box Gateway</div>
                        </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setShowHealthModal(false)} aria-label="Close" className="px-2">
                        <X size={20} />
                    </Button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* Status Cards */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="p-4 rounded-card bg-surface-2 border border-border">
                            <div className="text-xs text-text-muted uppercase tracking-wider font-semibold mb-1">Connection</div>
                            <div className="flex items-center gap-2">
                                <StatusDot state={healthData.connected ? 'ok' : 'fail'} />
                                <span className="font-bold text-lg text-text">{healthData.connected ? 'Connected' : 'Disconnected'}</span>
                            </div>
                        </div>
                        <div className="p-4 rounded-card bg-surface-2 border border-border">
                            <div className="text-xs text-text-muted uppercase tracking-wider font-semibold mb-1">External IP</div>
                            <div className="font-mono text-lg text-text">{healthData.externalIP || 'N/A'}</div>
                        </div>
                        <div className="p-4 rounded-card bg-surface-2 border border-border">
                            <div className="text-xs text-text-muted uppercase tracking-wider font-semibold mb-1">Uptime</div>
                            <div className="font-mono text-lg text-text">
                                {healthData.uptime ? `${Math.floor(healthData.uptime / 3600)}h ${Math.floor((healthData.uptime % 3600) / 60)}m` : 'N/A'}
                            </div>
                        </div>
                    </div>

                    {/* DNS Info */}
                    <div className="space-y-2">
                        <h4 className="font-bold text-text-muted flex items-center gap-2">
                            <Globe size={16} />
                            DNS Configuration
                        </h4>
                        <div className="bg-surface-2 rounded-card border border-border overflow-hidden">
                            {healthData.dnsServers && healthData.dnsServers.length > 0 ? (
                                <div className="divide-y divide-border">
                                    {healthData.dnsServers.map((dns: string, i: number) => {
                                        const isInternal = dns.startsWith('192.168.') || dns.startsWith('10.') || dns.startsWith('127.');
                                        return (
                                            <div key={i} className="p-3 flex items-center justify-between">
                                                <div className="flex items-center gap-3">
                                                    <span className="font-mono text-sm text-text">{dns}</span>
                                                    {isInternal ? (
                                                        <Badge variant="warn" className="text-[10px]">
                                                            Internal (Pi-hole/AdGuard)
                                                        </Badge>
                                                    ) : (
                                                        <Badge variant="info" className="text-[10px]">
                                                            External (ISP/Google)
                                                        </Badge>
                                                    )}
                                                </div>
                                                {i === 0 && <span className="text-xs text-text-subtle italic">Primary</span>}
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="p-4 text-sm text-text-subtle italic">No DNS servers detected</div>
                            )}
                        </div>
                    </div>

                    {/* Device Logs — intentional dark terminal console (raw
                        literal kept by design, consistent with the logs cluster
                        ContainerLogsPanel body). */}
                    <div className="space-y-2 flex-1 min-h-0 flex flex-col">
                        <h4 className="font-bold text-text-muted flex items-center gap-2">
                            <FileText size={16} />
                            Device Logs
                        </h4>
                        <div className="bg-surface-muted text-muted rounded-card border border-border p-4 font-mono text-xs overflow-auto max-h-[400px] whitespace-pre-wrap">
                            {healthData.deviceLog || 'No logs available.'}
                        </div>
                    </div>
                </div>
            </div>
        </div>
      )}

      {/* Link Modal */}
      <ExternalLinkModal
        isOpen={showLinkModal}
        onClose={() => setShowLinkModal(false)}
        onSave={handleSaveLink}
        form={linkForm}
        setForm={setLinkForm}
        isEditing={true}
      />

      {/* Connection Modal */}
      {showConnectionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-surface border border-border rounded-panel shadow-xl p-6 w-96 max-w-full m-4">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-bold text-text">Create Connection</h3>
                    <Button variant="ghost" size="sm" onClick={() => setShowConnectionModal(false)} aria-label="Close" className="px-2">
                        <X size={20} />
                    </Button>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-text-muted mb-2">
                            Target Port
                        </label>

                        {availablePorts.length > 0 && (
                            <div className="space-y-2 mb-3">
                                {availablePorts.map(port => (
                                    <label key={port} className="flex items-center gap-2 cursor-pointer p-2 rounded-card hover:bg-surface-2 border border-transparent hover:border-border">
                                        <Input
                                            type="radio"
                                            name="targetPort"
                                            value={port}
                                            checked={connectionPort === port.toString()}
                                            onChange={(e) => setConnectionPort(e.target.value)}
                                            className="text-accent focus:ring-accent"
                                        />
                                        <span className="text-sm font-mono text-text">:{port}</span>
                                    </label>
                                ))}
                                <label className="flex items-center gap-2 cursor-pointer p-2 rounded-card hover:bg-surface-2 border border-transparent hover:border-border">
                                    <Input
                                        type="radio"
                                        name="targetPort"
                                        value="custom"
                                        checked={!availablePorts.includes(parseInt(connectionPort))}
                                        onChange={() => setConnectionPort('')}
                                        className="text-accent focus:ring-accent"
                                    />
                                    <span className="text-sm text-text">Other</span>
                                </label>
                            </div>
                        )}

                        {(!availablePorts.length || !availablePorts.includes(parseInt(connectionPort))) && (
                             <Input
                                type="number"
                                value={connectionPort}
                                onChange={(e) => setConnectionPort(e.target.value)}
                                placeholder="e.g. 8080"
                                className="w-full px-3 py-2 border border-border rounded-card bg-surface-2 text-text focus:ring-2 focus:ring-accent outline-none"
                                autoFocus={!availablePorts.length}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveConnection();
                                }}
                            />
                        )}

                        <p className="text-xs text-text-subtle mt-1">
                            {availablePorts.length > 0 ? 'Select a known port or enter a custom one.' : 'Enter the target port for this connection.'}
                        </p>
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        <Button variant="ghost" onClick={() => setShowConnectionModal(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleSaveConnection}>
                            Create Link
                        </Button>
                    </div>
                </div>
            </div>
        </div>
      )}

      {/* IA slice 1 (#2029): the network map's bespoke per-service controls
          (service-action overlays + per-container logs/terminal drawer) were
          only reachable from the old sidebar's ServiceActionBar /
          AttachedContainerList, which the shared ServiceDetailSummary replaced.
          Those actions now live on the linked per-service Operate page, so there
          is one source of truth. */}
      {serviceActionOverlays}

      {/* Context Menu / Details Panel */}
      {selectedNodeData && (
          <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm">
              <div className="w-full sm:max-w-md h-full bg-surface border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right-10">
                  <div className="flex items-start justify-between px-5 py-4 border-b border-border gap-3">
                      <div className="min-w-0 flex-1">
                          <p className="text-xs uppercase font-semibold tracking-[0.2em] text-text-subtle">Node Details</p>
                          <h3 className="font-bold text-xl truncate text-text" title={selectedNodeData.label}>{selectedNodeData.label}</h3>
                          <div className="text-xs text-text-muted font-mono truncate" title={selectedNodeData.id}>{selectedNodeData.id}</div>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setSelectedNodeData(null)} aria-label="Close" className="px-2 shrink-0">
                          <X size={16} />
                      </Button>
                  </div>
                  <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                      <div className="flex items-center justify-between p-3 bg-surface-2 rounded-card">
                          <span className="text-sm text-text-muted">Status</span>
                          <Badge variant={selectedNodeData.status === 'up' ? 'ok' : 'fail'}>
                              {selectedNodeData.status?.toUpperCase() || 'UNKNOWN'}
                          </Badge>
                      </div>

                      {/* Actions */}
                      <div className="grid grid-cols-1 gap-2">
                        {selectedNodeData.type === 'router' && (
                            <Button
                                variant="secondary"
                                onClick={() => {
                                    setHealthData((selectedNodeData.rawData as HealthData) || null);
                                    setShowHealthModal(true);
                                }}
                                className="w-full"
                            >
                                <Activity size={14} />
                                Device Health
                            </Button>
                        )}

                        {selectedNodeData.type === 'device' && (
                            <Button
                                variant="secondary"
                                onClick={() => {
                                    const url = selectedNodeData.metadata?.verifiedDomains?.[0] || selectedNodeData.metadata?.link || '';
                                    setLinkForm({
                                        name: selectedNodeData.label || '',
                                        url: url,
                                        description: selectedNodeData.metadata?.description || '',
                                        monitor: true
                                    });
                                    setShowLinkModal(true);
                                }}
                                className="w-full"
                            >
                                <LinkIcon size={14} />
                                Create External Link
                            </Button>
                        )}

                        {selectedNodeData.type === 'unmanaged-service' && (
                            <Button
                                variant="secondary"
                                onClick={() => handleNavigateToBundleMigration(selectedNodeData)}
                                className="w-full"
                            >
                                <ArrowRight size={14} />
                                Migrate Bundle
                            </Button>
                        )}

                        {selectedNodeData.type === 'link' && (
                            <Button
                                variant="secondary"
                                onClick={handleEditLink}
                                className="w-full"
                            >
                                <Edit size={14} />
                                Edit Link
                            </Button>
                        )}

                        {selectedNodeData.type === 'container' && selectedNodeData.rawData?.Id && (
                            <Link
                                href={`/status?tab=containers&containerId=${selectedNodeData.rawData.Id}`}
                                className="w-full flex items-center justify-center gap-2 h-10 px-space-4 bg-surface-2 text-text border border-border hover:bg-surface-muted hover:border-border-strong rounded-card transition-colors text-sm font-medium"
                            >
                                <Info size={14} />
                                Inspect Container
                            </Link>
                        )}

                        {selectedNodeData && selectedNodeData.type === 'service' && typeof selectedNodeData.rawData?.name === 'string' && !selectedNodeData.metadata?.isMissingService && (
                            <Link
                                href={buildServiceEditHref(selectedNodeData)}
                                className="w-full flex items-center justify-center gap-2 h-10 px-space-4 bg-surface-2 text-text border border-border hover:bg-surface-muted hover:border-border-strong rounded-card transition-colors text-sm font-medium"
                            >
                                <Edit size={14} />
                                Edit Service
                            </Link>
                        )}

                        {selectedNodeData?.metadata?.isMissingService && (
                            <div className="p-3 rounded-card bg-status-warn/10 border border-status-warn/20 text-xs text-status-warn space-y-1">
                                <div className="font-semibold">No matching service found</div>
                                <div>
                                    Nginx forwards traffic to <span className="font-mono">{(selectedNodeData.metadata.targetUrl as string) || selectedNodeData.label}</span>, but no managed container or service is listening on that port. The most common causes: a stale proxy route from a removed/renamed service, or a service that crashed before it could bind.
                                </div>
                                <div>
                                    Fix it by editing or deleting the route in <span className="font-mono">Settings → Reverse Proxy</span> (or directly in NPM admin).
                                </div>
                            </div>
                        )}

                        {selectedNodeData.type === 'proxy' && (
                            <Link
                                href="/settings/network-domain#reverse-proxy"
                                className="w-full flex items-center justify-center gap-2 h-10 px-space-4 bg-surface-2 text-text border border-border hover:bg-surface-muted hover:border-border-strong rounded-card transition-colors text-sm font-medium"
                            >
                                <Edit size={14} />
                                Configure Proxy
                            </Link>
                        )}

                        {selectedNodeData.rawData?.metadata?.link && (
                            <Link
                                href={selectedNodeData.rawData?.metadata?.link || '#'}
                                target="_blank"
                                className="flex items-center justify-center w-full text-center h-10 px-space-4 bg-accent text-on-accent hover:bg-accent-strong rounded-card transition-colors text-sm font-medium"
                            >
                                Open Service ↗
                            </Link>
                        )}
                      </div>

                      {/* IA slice 1 (#2029, spec §4.2): the per-service detail is
                          the ONE shared ServiceDetailSummary — identical to the
                          Operate page header — so the map sidebar can no longer
                          drift from the rest of the UI. The old bespoke
                          ServiceActionBar + AttachedContainerList panel is gone;
                          full lifecycle + per-container logs/shell live on the
                          linked Operate page (status + health + settings +
                          containers + actions). */}
                      {selectedServiceViewModel && (
                          <div className="border border-border rounded-card p-3">
                              <ServiceDetailSummary service={selectedServiceViewModel} />
                          </div>
                      )}

                      {/* Network Info */}
                      <div className="border-t border-border pt-3">
                          <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Network Details</h4>
                          <div className="space-y-1 text-sm">
                              {selectedNodeData.ip && (
                                  <div className="flex justify-between">
                                      <span className="text-text-muted">IP Address</span>
                                      <span className="font-mono text-text">{selectedNodeData.ip}</span>
                                  </div>
                              )}
                              {/* Host Network Flag */}
                              {selectedNodeData.rawData?.hostNetwork && (
                                  <div className="flex justify-between">
                                      <span className="text-text-muted">Mode</span>
                                      <span className="font-mono text-status-warn font-bold">Host Network</span>
                                  </div>
                              )}
                              {selectedNodeData.rawData?.ports && selectedNodeData.rawData.ports.length > 0 && (
                                  <div className="flex justify-between">
                                      <span className="text-text-muted">Ports</span>
                                      <span className="font-mono text-text">
                                        {(selectedNodeData.rawData.ports as unknown[]).map((p) => {
                                            if (typeof p === 'object' && p !== null) {
                                                const port = p as LegacyPortMapping;
                                                const h = port.host || port.hostPort;
                                                const c = port.container || port.containerPort;
                                                return h && c && h !== c ? `${h}:${c}` : (h || c);
                                            }
                                            return String(p);
                                        }).join(', ')}
                                      </span>
                                  </div>
                              )}
                              {selectedNodeData.rawData?.MacAddress && (
                                  <div className="flex justify-between">
                                      <span className="text-text-muted">MAC</span>
                                      <span className="font-mono text-text">{selectedNodeData.rawData.MacAddress}</span>
                                  </div>
                              )}
                          </div>
                      </div>

                      {/* Debug Info */}
                      <div className="border-t border-border pt-3">
                          <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Debug Info</h4>
                          <div className="space-y-1 text-xs font-mono text-text-muted">
                              <div className="flex justify-between">
                                  <span>Node ID</span>
                                  <span>{selectedNodeData.id}</span>
                              </div>
                              <div className="flex justify-between">
                                  <span>Type</span>
                                  <span>{selectedNodeData.type}</span>
                              </div>
                              {selectedNodeData.parentId && (
                                  <div className="flex justify-between">
                                      <span>Parent</span>
                                      <span>{selectedNodeData.parentId}</span>
                                  </div>
                              )}
                          </div>
                      </div>

                      {/* Raw Data */}
                      <div className="border-t border-border pt-3 pb-2">
                          <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Raw Data</h4>
                          <div className="bg-surface-muted p-2 rounded-card overflow-x-auto">
                              <pre className="text-[10px] font-mono text-text-muted whitespace-pre-wrap break-all">
                                  {JSON.stringify(selectedNodeData.rawData, null, 2)}
                              </pre>
                          </div>
                      </div>
                  </div>
              </div>
          </div>
      )}

      {selectedEdge && (
          <div className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-sm">
              <div className="w-full sm:max-w-sm h-full bg-surface border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right-10">
                  <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                      <div>
                          <p className="text-xs uppercase font-semibold tracking-[0.2em] text-text-subtle">Connection</p>
                          <h3 className="font-bold text-text">Link Details</h3>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setSelectedEdge(null)} aria-label="Close" className="px-2">
                          <X size={16} />
                      </Button>
                  </div>
                  <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                      <p className="text-sm text-text-muted">
                          {selectedEdgeMeta?.isManual
                              ? 'Manual connection between nodes.'
                              : 'Auto-discovered link inferred from real traffic.'}
                      </p>
                      <div className="space-y-2 text-xs font-mono text-text-muted">
                          <div className="flex justify-between">
                              <span>Port</span>
                              <span>{selectedEdgeMeta?.port ? `:${selectedEdgeMeta.port}` : 'unassigned'}</span>
                          </div>
                          <div className="flex justify-between">
                              <span>Status</span>
                              <span className="uppercase">{selectedEdgeMeta?.state || 'UNKNOWN'}</span>
                          </div>
                      </div>
                      {selectedEdgeMeta?.isManual ? (
                          <Button
                              variant="danger"
                              onClick={handleDeleteEdge}
                              className="w-full"
                          >
                              <Trash2 size={14} />
                              Remove Connection
                          </Button>
                      ) : (
                          <p className="text-xs text-text-muted">
                              Auto-discovered edges cannot be removed manually.
                          </p>
                      )}
                  </div>
              </div>
          </div>
      )}
    </div>
  );
}
