'use client';

/**
 * The graph's custom edge renderer, lifted verbatim out of NetworkDashboard.tsx
 * (#2743) so the dashboard is the page, not the whole graph toolkit.
 */
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, Position } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { buildOrthogonalPath } from './networkDashboard';


// #1782 orthogonal path + #1784 line-hop geometry live in
// ./_lib/networkDashboard (buildOrthogonalPath) so the dashboard stays under
// the file-size invariant and the path math is unit-testable.

// Helper: calculate edge path and label position
// #1782 — prefer ELK's orthogonal routing points (attached as data.points
// by getLayoutedElements). Fall back to smoothstep when ELK didn't route.
// #1784 — hop points where horizontal runs cross different edges.
// #1783 — prefer ELK's CENTER-placed label position (data.lpos).
function calculateEdgePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  sourcePosition: Position,
  targetPosition: Position,
  data: Record<string, unknown> | undefined
) {
  const elkPoints = (data as { points?: { x: number; y: number }[] } | undefined)?.points;
  const hops = (data as { hops?: { x: number; y: number }[] } | undefined)?.hops ?? [];

  let edgePath: string;
  let labelX: number;
  let labelY: number;

  if (elkPoints && elkPoints.length >= 2) {
    const built = buildOrthogonalPath(elkPoints, hops);
    edgePath = built.path;
    labelX = built.labelX;
    labelY = built.labelY;
  } else {
    [edgePath, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
  }

  const lpos = (data as { lpos?: { x: number; y: number } } | undefined)?.lpos;
  const chipX = lpos?.x ?? labelX;
  const chipY = lpos?.y ?? labelY;

  return { edgePath, chipX, chipY };
}

// Custom Edge Component
export const CustomEdge = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label,
  data,
}: EdgeProps) => {
  const { edgePath, chipX, chipY } = calculateEdgePath(
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data
  );

  if (!label) {
      return <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />;
  }

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${chipX}px,${chipY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan bg-surface px-2 py-1 rounded-chip border border-border shadow-sm text-[10px] font-mono text-text-muted text-center z-10"
        >
          {String(label).split('\n').map((line: string, i: number) => (
            <div key={i} className={i === 0 && String(label).includes('\n') ? "font-bold border-b border-border mb-0.5 pb-0.5" : ""}>
                {line}
            </div>
          ))}
        </div>
      </EdgeLabelRenderer>
    </>
  );
};

