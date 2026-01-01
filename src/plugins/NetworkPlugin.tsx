'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, Node, Edge, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { NetworkGraph } from '@/lib/network/types';
import { RefreshCw } from 'lucide-react';
import PageHeader from '@/components/PageHeader';

const nodeWidth = 172;
const nodeHeight = 80;

const getLayoutedElements = (nodes: Node[], edges: Edge[]) => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  dagreGraph.setGraph({ rankdir: 'LR' });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
};

export default function NetworkPlugin() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading] = useState(true);

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/network/graph');
      if (!res.ok) throw new Error('Failed to fetch graph');
      const data: NetworkGraph = await res.json();

      // Transform to React Flow format
      const flowNodes: Node[] = data.nodes.map(n => {
        let className = 'border rounded-xl shadow-sm p-2 ';
        if (n.type === 'internet') className += 'bg-sky-100 dark:bg-sky-900 border-sky-200 dark:border-sky-800 text-sky-900 dark:text-sky-100';
        else if (n.type === 'router') className += 'bg-amber-100 dark:bg-amber-900 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100';
        else if (n.type === 'proxy') className += 'bg-emerald-100 dark:bg-emerald-900 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-100';
        else className += 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white';

        return {
            id: n.id,
            type: 'default',
            position: { x: 0, y: 0 },
            className,
            data: { 
                label: (
                    <div className="flex flex-col items-center">
                        <div className="font-bold">{n.label}</div>
                        {n.subLabel && <div className={`text-xs ${n.type === 'internet' || n.type === 'router' || n.type === 'proxy' ? 'opacity-80' : 'text-gray-500 dark:text-gray-400'}`}>{n.subLabel}</div>}
                        <div className={`mt-2 w-2 h-2 rounded-full ${n.status === 'up' ? 'bg-green-500' : 'bg-red-500'}`} />
                    </div>
                ) 
            },
            style: { 
                width: nodeWidth,
            }
        };
      });

      const flowEdges: Edge[] = data.edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        animated: e.state === 'active',
        style: { stroke: e.state === 'active' ? '#22c55e' : '#9ca3af' }
      }));

      const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(flowNodes, flowEdges);

      setNodes(layoutedNodes);
      setEdges(layoutedEdges);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [setNodes, setEdges]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Network Map" showBack={false}>
        <button 
            onClick={fetchGraph}
            disabled={loading}
            className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
        >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
        </button>
      </PageHeader>
      
      <div className="flex-1 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
    </div>
  );
}
