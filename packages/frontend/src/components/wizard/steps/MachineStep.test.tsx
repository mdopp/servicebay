/**
 * MachineStep — radio Input primitive swap (no-raw-ui-primitive sweep).
 *
 * The "Public Domain" / "Internal Only" reachability cards were raw
 * `<input type="radio" className="sr-only">` elements; they now delegate to
 * the shared `Input` primitive from `@/components/ui`. This file had no test
 * at all, so the swap shipped with zero coverage — render the step and drive
 * both radio cards through their labels.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { MachineStep } from './MachineStep';

function baseProps(overrides: Partial<React.ComponentProps<typeof MachineStep>> = {}) {
  return {
    installMode: 'lan' as const,
    setInstallMode: vi.fn(),
    publicDomain: '',
    setPublicDomain: vi.fn(),
    operatorEmail: '',
    setOperatorEmail: vi.fn(),
    isValidOperatorEmail: () => true,
    operatorEmailIssue: () => '',
    detectedRaid: undefined,
    availableStacks: [],
    navigateTo: vi.fn(),
    detectedDrives: [],
    stackLoadingDevices: false,
    ...overrides,
  };
}

describe('MachineStep — radio Input primitive swap (#no-raw-ui-primitive)', () => {
  it('renders both reachability radios as real inputs and switches mode on click', () => {
    const setInstallMode = vi.fn();
    render(<MachineStep {...baseProps({ setInstallMode })} />);

    const publicRadio = screen.getByLabelText('Yes, public domain') as HTMLInputElement;
    const lanRadio = screen.getByLabelText('No, internal only') as HTMLInputElement;
    expect(publicRadio.tagName).toBe('INPUT');
    expect(publicRadio.type).toBe('radio');
    expect(lanRadio.checked).toBe(true);

    fireEvent.click(publicRadio);
    expect(setInstallMode).toHaveBeenCalledWith('public');
  });

  it('shows the public-domain warning and returns to Network on click', () => {
    const navigateTo = vi.fn();
    render(<MachineStep {...baseProps({ installMode: 'public', publicDomain: '', navigateTo })} />);

    expect(screen.getByText('Public domain not set')).toBeTruthy();
    fireEvent.click(screen.getByText('Return to Network'));
    expect(navigateTo).toHaveBeenCalledWith('network');
  });
});
