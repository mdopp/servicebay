/**
 * `/edit/[name]` must hand ServiceForm the node it already resolved.
 *
 * ServiceForm seeds `selectedNode` from `defaultNode ?? (?node= || '')`,
 * disables the node <select> whenever `isEdit`, and disables Save while
 * `!selectedNode`. This page resolved `nodeName` (defaulting to 'Local') in
 * order to read the service files and then rendered `<ServiceForm initialData
 * isEdit />` without passing it on. On a URL with no `?node=` — which is every
 * link into this page — the form came up with an empty AND locked node field
 * and a permanently greyed-out Save. #2392 fixed the same defect in
 * OperateSettingsTab and missed this entry point.
 *
 * The sibling tests in components/ServiceForm.test.tsx lock the component's
 * half of the contract. These lock the caller's half — without them the page
 * could silently drop the prop again and every component test would stay green.
 *
 * The page is an async server component, so it is awaited as a plain function
 * and the returned element tree is searched for the ServiceForm node. Nothing
 * is rendered: the assertion is about the props the page passes.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';

const ServiceFormStub = () => null;
vi.mock('@/components/ServiceForm', () => ({ __esModule: true, default: ServiceFormStub }));
vi.mock('@/components/PageHeader', () => ({ __esModule: true, default: () => null }));

const getServiceFiles = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/ServiceManager', () => ({ ServiceManager: { getServiceFiles } }));

const { default: EditPage } = await import('./page');

/** Depth-first search for the element whose type is the ServiceForm stub. */
function findServiceForm(node: unknown): ReactElement | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findServiceForm(child);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement & { props?: { children?: unknown } };
  if (el.type === ServiceFormStub) return el;
  return findServiceForm(el.props?.children);
}

async function renderPage(searchParams: Record<string, string> = {}) {
  getServiceFiles.mockResolvedValue({
    kubeContent: 'k',
    yamlContent: 'y',
    yamlPath: '/etc/containers/systemd/claude-dev.yml',
    kubePath: '/etc/containers/systemd/claude-dev.kube',
    serviceContent: '',
    servicePath: '',
  });
  const tree = await EditPage({
    params: Promise.resolve({ name: 'claude-dev' }),
    searchParams: Promise.resolve(searchParams),
  });
  const form = findServiceForm(tree);
  if (!form) throw new Error('ServiceForm was not rendered by the edit page');
  return form.props as { defaultNode?: string; isEdit?: boolean; initialData?: { name?: string } };
}

describe('/edit/[name] — passes the resolved node to ServiceForm', () => {
  it('defaults to Local when the URL carries no ?node=', async () => {
    const props = await renderPage();
    // The exact failure: this was `undefined`, which left Save unclickable.
    expect(props.defaultNode).toBe('Local');
  });

  it('passes a real node name through unchanged on a multi-node box', async () => {
    const props = await renderPage({ node: 'nas01' });
    expect(props.defaultNode).toBe('nas01');
  });

  it('treats the legacy ?node=local sentinel as Local', async () => {
    const props = await renderPage({ node: 'local' });
    expect(props.defaultNode).toBe('Local');
  });

  it('still seeds the form in edit mode with the service id from the URL', async () => {
    const props = await renderPage();
    expect(props.isEdit).toBe(true);
    expect(props.initialData?.name).toBe('claude-dev');
  });
});
