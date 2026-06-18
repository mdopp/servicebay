// disk-import-worker — in-container HTTP server (#1953, slice of #1949).
//
// The worker image serves BOTH the heavy job and the disk-import app frontend
// from one container (the operator's frontend-split decision). servicebay no
// longer runs the scan/review/apply in-process; it launches this container,
// provisions an NPM proxy + Authelia forward-auth route in front of it (#1954),
// and the dashboard shows only a launch TILE that opens this app's URL.
//
// The server is deliberately tiny and dependency-free (Node http only):
//   GET  /                 → the self-contained lazy-tree SPA (one HTML file)
//   GET  /api/devices      → removable partitions to pick from
//   POST /api/scan         → launch a dry-run scan job (writes status.json)
//   POST /api/apply        → launch an --apply job
//   GET  /api/status       → the COMPACT status.json (poll target)
//   GET  /api/tree?dir=…   → ONE directory's immediate children (lazy fetch)
//
// Auth is NOT handled here — the container sits behind the existing NPM +
// Authelia forward-auth (admin-gated), exactly like every other service UI, so
// there is no auth code in this package (the issue's "no new auth code").
//
// The lazy tree is the review-UX fix: /api/tree returns one level at a time so
// the browser (and this server) never materialise the 269k-node tree whole.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATUS_FILE, PLAN_SIDECAR_FILE, type WorkerStatus, type PlanSidecar } from '../contract/status';
import { lazyChildren, type LazyTreeLevel } from '../contract/lazyTree';
import { APP_HTML } from './appHtml';

/** Seams so the server is testable without a real filesystem / child process. */
export interface ServerDeps {
  /** Directory the worker writes status.json + plan.json into. */
  outDir: string;
  /** Read a JSON file under outDir; resolves null when absent/unparseable. */
  readJson: <T>(file: string) => Promise<T | null>;
  /** List removable partitions for the device picker. */
  listDevices: () => Promise<Array<{ path: string; display: string }>>;
  /** Launch a heavy job (dry-run or apply) as a detached child. */
  launchJob: (mode: 'dry-run' | 'apply', device: string) => Promise<void>;
}

/** JSON response helper. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Read + JSON-parse the request body (small bodies only — these are commands). */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** GET /api/status → the compact status doc (null → 204, nothing scanned yet). */
async function handleStatus(deps: ServerDeps, res: ServerResponse): Promise<void> {
  const status = await deps.readJson<WorkerStatus>(STATUS_FILE);
  if (!status) {
    res.writeHead(204).end();
    return;
  }
  sendJson(res, 200, status);
}

/** GET /api/tree?dir=… → one level of children (the lazy fetch). */
async function handleTree(deps: ServerDeps, url: URL, res: ServerResponse): Promise<void> {
  const sidecar = await deps.readJson<PlanSidecar>(PLAN_SIDECAR_FILE);
  if (!sidecar) {
    sendJson(res, 409, { error: 'no plan yet — scan first' });
    return;
  }
  const dir = url.searchParams.get('dir') ?? '';
  const level: LazyTreeLevel = lazyChildren(sidecar.plan, dir, sidecar.mountBase);
  sendJson(res, 200, level);
}

/** POST /api/scan|/api/apply → launch the heavy job. */
async function handleLaunch(
  deps: ServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  mode: 'dry-run' | 'apply',
): Promise<void> {
  const body = await readBody(req);
  const device = typeof body.device === 'string' ? body.device : '';
  if (!device) {
    sendJson(res, 400, { error: 'device is required' });
    return;
  }
  await deps.launchJob(mode, device);
  sendJson(res, 202, { ok: true });
}

/** Dispatch a GET request to its handler, or null when none matches. */
function getRoute(
  deps: ServerDeps,
  url: URL,
  res: ServerResponse,
): Promise<void> | null {
  switch (url.pathname) {
    case '/':
    case '/index.html':
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(APP_HTML);
      return Promise.resolve();
    case '/api/status':
      return handleStatus(deps, res);
    case '/api/tree':
      return handleTree(deps, url, res);
    case '/api/devices':
      return deps.listDevices().then(devices => sendJson(res, 200, { devices }));
    default:
      return null;
  }
}

/** Route one request. Exported for unit tests (no socket needed). */
export async function handleRequest(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://worker.local');
  try {
    if (req.method === 'GET') {
      const handled = getRoute(deps, url, res);
      if (handled) return await handled;
    } else if (req.method === 'POST' && (url.pathname === '/api/scan' || url.pathname === '/api/apply')) {
      return await handleLaunch(deps, req, res, url.pathname === '/api/apply' ? 'apply' : 'dry-run');
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Default file reader: JSON under outDir, null on any error. */
export function fileReader(outDir: string): ServerDeps['readJson'] {
  return async <T>(file: string): Promise<T | null> => {
    try {
      const raw = await readFile(path.join(outDir, file), 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };
}

/** Start the HTTP server. Returns the node server (for a graceful shutdown). */
export function startServer(deps: ServerDeps, port: number) {
  const server = createServer((req, res) => {
    void handleRequest(deps, req, res);
  });
  server.listen(port, () => {
    console.log(`disk-import-worker app listening on :${port}`);
  });
  return server;
}

/** Resolve a path inside this module (the SPA asset lives next to the server). */
export function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}
