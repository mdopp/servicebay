import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { NetworkLegend, getMiniMapNodeColor, getMiniMapStrokeColor } from './NetworkLegend';
import { MINIMAP_NODE_COLORS, MINIMAP_STROKE_COLORS } from './networkDashboard';

/**
 * The legend panel and the MiniMap colour lookups moved out of
 * NetworkDashboard.tsx in the #2743 god-module cut. The dashboard's own render
 * tests mount the graph but never open the legend, so these pin the seam:
 * the panel still collapses/expands and still names every edge kind and badge.
 */

const openLegend = () => {
  render(<ReactFlowProvider><NetworkLegend /></ReactFlowProvider>);
  fireEvent.click(screen.getByText('Legend'));
};

describe('NetworkLegend (#2743)', () => {
  it('renders collapsed, with only the toggle', () => {
    render(<ReactFlowProvider><NetworkLegend /></ReactFlowProvider>);
    expect(screen.getByText('Legend')).toBeTruthy();
    expect(screen.queryByText('Observed TCP flow')).toBeNull();
  });

  it('expands to the full body: node kinds, edge kinds and the #1785 badges', () => {
    openLegend();
    for (const label of [
      'Service / Pod',
      'Container',
      'Gateway',
      'External Link',
      'Group / Node',
      'Active / Running',
      'Stopped / Error',
      'Observed TCP flow',
      'Declared dependency',
      'Inferred (env / host)',
      'SSO',
      'DNS',
    ]) {
      expect(screen.getByText(label), `legend must still list "${label}"`).toBeTruthy();
    }
  });

  it('collapses again on a second click', () => {
    openLegend();
    fireEvent.click(screen.getByText('Legend'));
    expect(screen.queryByText('Observed TCP flow')).toBeNull();
  });
});

describe('MiniMap colour lookups (#2743)', () => {
  it('resolves a known node type from the shared palette', () => {
    const [type, color] = Object.entries(MINIMAP_NODE_COLORS)[0];
    expect(getMiniMapNodeColor(type)).toBe(color);
    expect(getMiniMapStrokeColor(type)).toBe(MINIMAP_STROKE_COLORS[type]);
  });

  it('falls back to the internet colour for an unknown type', () => {
    expect(getMiniMapNodeColor('not-a-type')).toBe(MINIMAP_NODE_COLORS.internet);
    expect(getMiniMapStrokeColor('not-a-type')).toBe(MINIMAP_STROKE_COLORS.internet);
  });
});
