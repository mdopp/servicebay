import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest, type ServerDeps } from './server';
import { STATUS_FILE, PLAN_SIDECAR_FILE, type WorkerStatus, type PlanSidecar } from '../contract/status';
import type { ImportPlan } from '../engine/types';

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: '',
    writeHead(status: number, headers?: Record<string, unknown>) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
      return this;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      return this;
    },
  };
  return res as unknown as ServerResponse & typeof res;
}

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as unknown as IncomingMessage;
  stream.method = method;
  stream.url = url;
  return stream;
}

const plan: ImportPlan = {
  items: [{ record: { sourcePath: '/mnt/src/p/a.jpg', size: 1, mtimeMs: 0, ext: 'jpg', name: 'a.jpg' }, category: 'photos', target: 'p/a.jpg', action: 'copy' }],
  conflicts: [],
};

function deps(over: Partial<ServerDeps> = {}): ServerDeps {
  const files: Record<string, unknown> = {
    [STATUS_FILE]: { phase: 'done', planned: 1 } as Partial<WorkerStatus>,
    [PLAN_SIDECAR_FILE]: { version: 1, runId: 'r', plan, mountBase: '/mnt/src' } as PlanSidecar,
  };
  return {
    outDir: '/out',
    readJson: async <T>(f: string) => (files[f] as T) ?? null,
    listDevices: async () => [{ path: '/dev/sda1', display: 'USB' }],
    launchJob: vi.fn(async () => {}),
    ...over,
  };
}

describe('worker server handleRequest', () => {
  it('serves the SPA at /', async () => {
    const res = mockRes();
    await handleRequest(deps(), mockReq('GET', '/'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<!doctype html>');
  });

  it('returns the compact status.json', async () => {
    const res = mockRes();
    await handleRequest(deps(), mockReq('GET', '/api/status'), res);
    expect(JSON.parse(res.body)).toMatchObject({ phase: 'done', planned: 1 });
  });

  it('returns 204 when no status yet', async () => {
    const res = mockRes();
    await handleRequest(deps({ readJson: async () => null }), mockReq('GET', '/api/status'), res);
    expect(res.statusCode).toBe(204);
  });

  it('returns ONE lazy tree level', async () => {
    const res = mockRes();
    await handleRequest(deps(), mockReq('GET', '/api/tree?dir='), res);
    const level = JSON.parse(res.body);
    expect(level.children.map((c: { dir: string }) => c.dir)).toEqual(['p']);
  });

  it('launches a scan and 202s', async () => {
    const d = deps();
    const res = mockRes();
    await handleRequest(d, mockReq('POST', '/api/scan', { device: '/dev/sda1' }), res);
    expect(res.statusCode).toBe(202);
    expect(d.launchJob).toHaveBeenCalledWith('dry-run', '/dev/sda1');
  });

  it('rejects a launch without a device', async () => {
    const res = mockRes();
    await handleRequest(deps(), mockReq('POST', '/api/scan', {}), res);
    expect(res.statusCode).toBe(400);
  });

  it('404s an unknown route', async () => {
    const res = mockRes();
    await handleRequest(deps(), mockReq('GET', '/nope'), res);
    expect(res.statusCode).toBe(404);
  });

  it('re-plans via POST /api/replan and returns the new counts', async () => {
    const replan = vi.fn(async () => ({ planned: 5, conflicts: 0 }));
    const res = mockRes();
    await handleRequest(
      deps({ replan }),
      mockReq('POST', '/api/replan', { explicit: { mdopp: { owner: 'mdopp' } } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, planned: 5, conflicts: 0 });
    expect(replan).toHaveBeenCalledWith({ explicit: { mdopp: { owner: 'mdopp' } }, rootDefault: undefined });
  });

  it('503s /api/replan when the seam is absent (sandboxed deps)', async () => {
    const res = mockRes();
    await handleRequest(deps(), mockReq('POST', '/api/replan', { explicit: {} }), res);
    expect(res.statusCode).toBe(503);
  });

  it('409s /api/replan when there is no plan yet', async () => {
    const replan = vi.fn(async () => {
      throw new Error('disk-import: no plan to re-plan — scan first');
    });
    const res = mockRes();
    await handleRequest(deps({ replan }), mockReq('POST', '/api/replan', { explicit: {} }), res);
    expect(res.statusCode).toBe(409);
  });

  it('does NOT leak the internal error message/stack on a 500 (#2255)', async () => {
    const secret = 'ENOENT: secret internal path /out/plan.json at Object.<anonymous>';
    const replan = vi.fn(async () => {
      throw new Error(secret);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = mockRes();
    await handleRequest(deps({ replan }), mockReq('POST', '/api/replan', { explicit: {} }), res);
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal server error' });
    expect(res.body).not.toContain(secret);
    // The detail is still logged server-side for diagnosis.
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('does NOT leak the internal error on a top-level handler throw (#2255)', async () => {
    const secret = 'boom: /out internal detail';
    const readJson = vi.fn(async () => {
      throw new Error(secret);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = mockRes();
    await handleRequest(deps({ readJson }), mockReq('GET', '/api/status'), res);
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal server error' });
    expect(res.body).not.toContain(secret);
    errSpy.mockRestore();
  });
});
