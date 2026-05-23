/**
 * Foundation tests for the WorkspaceDrawer primitive (#804).
 *
 * Pin the load-bearing structural behaviour at the jsdom level so a
 * future refactor can't quietly:
 *  - render the drawer while closed
 *  - drop the close button
 *  - lose the backdrop dimming on a confirm-style drawer
 *  - or stop disabling pointer events on the page when `hasBackdrop` is false.
 *
 * Visual morph between width variants is a manual-QA item — there is
 * no jsdom layout, so the test only asserts the Tailwind max-w-* class
 * lands on the panel.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import WorkspaceDrawer from '@/components/WorkspaceDrawer';

describe('WorkspaceDrawer (#804)', () => {
  function renderDrawer(props: Partial<React.ComponentProps<typeof WorkspaceDrawer>> = {}) {
    const onClose = vi.fn();
    const utils = render(
      <WorkspaceDrawer
        isOpen
        onClose={onClose}
        header={<h2>Service Foo</h2>}
        {...props}
      >
        <div>Body content</div>
      </WorkspaceDrawer>,
    );
    return { ...utils, onClose };
  }

  it('renders nothing when isOpen is false', () => {
    const { queryByText } = render(
      <WorkspaceDrawer isOpen={false} onClose={() => undefined} header={<h2>Hidden</h2>}>
        <div>Body</div>
      </WorkspaceDrawer>,
    );
    expect(queryByText('Hidden')).toBeNull();
    expect(queryByText('Body')).toBeNull();
  });

  it('renders header + body when open', () => {
    renderDrawer();
    expect(screen.getByText('Service Foo')).toBeDefined();
    expect(screen.getByText('Body content')).toBeDefined();
  });

  it('fires onClose when the X button is clicked', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByLabelText('Close drawer'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('honours a custom closeAriaLabel', () => {
    renderDrawer({ closeAriaLabel: 'Dismiss panel' });
    expect(screen.getByLabelText('Dismiss panel')).toBeDefined();
  });

  it('renders the backdrop wrapper by default (hasBackdrop=true)', () => {
    const { container } = renderDrawer();
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toMatch(/\bbackdrop-blur-sm\b/);
    expect(wrapper.className).not.toMatch(/pointer-events-none/);
  });

  it('drops the backdrop and re-enables click-through when hasBackdrop=false', () => {
    const { container } = renderDrawer({ hasBackdrop: false });
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toMatch(/\bpointer-events-none\b/);
    expect(wrapper.className).not.toMatch(/backdrop-blur-sm/);
    // The panel itself re-enables pointer events so it stays interactive.
    const panel = wrapper.firstElementChild as HTMLElement;
    expect(panel.className).toMatch(/\bpointer-events-auto\b/);
  });

  it('applies the wide width class by default', () => {
    const { container } = renderDrawer();
    const panel = (container.firstElementChild?.firstElementChild) as HTMLElement;
    expect(panel.className).toMatch(/\bmax-w-6xl\b/);
  });

  it('applies the standard width class when width=standard', () => {
    const { container } = renderDrawer({ width: 'standard' });
    const panel = (container.firstElementChild?.firstElementChild) as HTMLElement;
    expect(panel.className).toMatch(/\bmax-w-2xl\b/);
  });

  it('omits the max-w-* class when width=full', () => {
    const { container } = renderDrawer({ width: 'full' });
    const panel = (container.firstElementChild?.firstElementChild) as HTMLElement;
    expect(panel.className).not.toMatch(/\bmax-w-(2xl|6xl)\b/);
  });

  it('carries the cubic-bezier transition class on the panel', () => {
    const { container } = renderDrawer();
    const panel = (container.firstElementChild?.firstElementChild) as HTMLElement;
    // Width morphing transitions key off these classes (#804 follow-up).
    expect(panel.className).toMatch(/transition-all/);
    expect(panel.className).toMatch(/cubic-bezier/);
  });
});
