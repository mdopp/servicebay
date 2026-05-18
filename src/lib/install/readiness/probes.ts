/**
 * Probe execution primitives (#613) — single-shot calls. The waiting /
 * retrying loop lives in `runner.ts`; this module just answers "what does
 * this probe see right now?"
 *
 * All probes run server-side on the ServiceBay host. HTTP / TCP / LDAP
 * speak directly to the install target (loopback for the local node);
 * `command` probes shell out via the agent so they also work for remote
 * nodes.
 */
import net from 'net';
import { agentManager } from '@/lib/agent/manager';
import type {
  CommandProbe,
  HttpProbe,
  LdapProbe,
  ReadinessProbe,
  TcpProbe,
} from './types';

export interface ProbeAttempt {
  ok: boolean;
  /** Stable reason category — `null` on success. */
  reason: null | 'timeout' | 'unexpected-response' | 'network-error' | 'config-error';
  /** Short, operator-facing observation: status code, exit code, error text. */
  detail: string;
}

/* ─── HTTP ─────────────────────────────────────────────────────────────── */

function statusMatches(
  status: number,
  expect: HttpProbe['expectStatus'],
): boolean {
  if (expect === undefined) {
    // Default: any 2xx-4xx is acceptable as "service responded". 5xx and
    // network errors fail. This mirrors the existing wait_for_lldap pattern
    // where 401 is the readiness signal — strict 200 expectations are
    // declared explicitly.
    return status >= 200 && status < 500;
  }
  if (expect === 'any') return true;
  if (typeof expect === 'number') return status === expect;
  return status >= expect[0] && status <= expect[1];
}

async function probeHttp(probe: HttpProbe): Promise<ProbeAttempt> {
  // Reuse the existing AbortSignal.timeout pattern from lldap/probe — uniform
  // shape, and `fetch` cleanly aborts pending sockets on cancel.
  try {
    const res = await fetch(probe.url, {
      method: probe.method ?? 'GET',
      headers: probe.body
        ? { 'Content-Type': 'application/json' }
        : undefined,
      body: probe.body,
      signal: AbortSignal.timeout(probe.timeoutMs),
    });
    if (statusMatches(res.status, probe.expectStatus)) {
      return { ok: true, reason: null, detail: `HTTP ${res.status}` };
    }
    return {
      ok: false,
      reason: 'unexpected-response',
      detail: `HTTP ${res.status} (expected ${describeExpect(probe.expectStatus)})`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isAbort = e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(msg));
    return {
      ok: false,
      reason: isAbort ? 'timeout' : 'network-error',
      detail: isAbort ? 'request aborted (timeout)' : msg,
    };
  }
}

function describeExpect(expect: HttpProbe['expectStatus']): string {
  if (expect === undefined) return '2xx–4xx';
  if (expect === 'any') return 'any';
  if (typeof expect === 'number') return String(expect);
  return `${expect[0]}–${expect[1]}`;
}

/* ─── TCP ──────────────────────────────────────────────────────────────── */

async function probeTcp(probe: TcpProbe): Promise<ProbeAttempt> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finalize = (r: ProbeAttempt) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(probe.timeoutMs);
    socket.once('connect', () => finalize({ ok: true, reason: null, detail: `connected ${probe.host}:${probe.port}` }));
    socket.once('timeout', () => finalize({ ok: false, reason: 'timeout', detail: `TCP timeout after ${probe.timeoutMs}ms` }));
    socket.once('error', (err) => finalize({ ok: false, reason: 'network-error', detail: err.message }));
    socket.connect(probe.port, probe.host);
  });
}

/* ─── LDAP ─────────────────────────────────────────────────────────────── */

/**
 * Minimal LDAPv3 simple-bind in pure Node. Avoids adding `ldapjs` as a dep
 * (we use one bind once per probe — not worth ~1MB of transitive deps).
 *
 * Wire format (RFC 4511):
 *   LDAPMessage ::= SEQUENCE {
 *     messageID    INTEGER,
 *     protocolOp   CHOICE {
 *       bindRequest [APPLICATION 0] SEQUENCE {
 *         version       INTEGER (1..127),
 *         name          LDAPDN,
 *         authentication AuthenticationChoice {
 *           simple    [0] OCTET STRING
 *         }
 *       },
 *       bindResponse [APPLICATION 1] LDAPResult { resultCode, ... }
 *     }
 *   }
 *
 * Returns resultCode (0 = success, 49 = invalidCredentials, 52 = unavailable, etc.).
 */
function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) { bytes.unshift(n & 0xff); n >>>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

function encodeInt(n: number): Buffer {
  // Minimal-length two's-complement encoding for INTEGER. Our values are
  // always small non-negative integers (version, messageID), so single
  // byte if < 128, otherwise prefix with 0x00.
  if (n === 0) return tlv(0x02, Buffer.from([0]));
  const bytes: number[] = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>>= 8; }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

function encodeOctetString(s: string, tag: number = 0x04): Buffer {
  return tlv(tag, Buffer.from(s, 'utf-8'));
}

function buildBindRequest(bindDn: string, password: string): Buffer {
  // BindRequest tag = [APPLICATION 0] CONSTRUCTED = 0x60.
  // SimpleAuth tag  = [0] PRIMITIVE = 0x80.
  const bindReq = tlv(0x60, Buffer.concat([
    encodeInt(3), // LDAPv3
    encodeOctetString(bindDn),
    encodeOctetString(password, 0x80),
  ]));
  // Wrap in LDAPMessage with messageID=1.
  return tlv(0x30, Buffer.concat([
    encodeInt(1),
    bindReq,
  ]));
}

/** Parse the resultCode out of a BindResponse. Returns null on malformed
 *  responses. Trusts that the server sent a complete BindResponse — does
 *  not validate every field. */
function parseBindResult(buf: Buffer): number | null {
  // LDAPMessage SEQUENCE
  if (buf[0] !== 0x30) return null;
  // Skip the SEQUENCE header (tag + length).
  const lenInfo = readLength(buf, 1);
  if (!lenInfo) return null;
  let off = lenInfo.off;
  // messageID INTEGER
  if (buf[off] !== 0x02) return null;
  const idLen = readLength(buf, off + 1);
  if (!idLen) return null;
  off = idLen.off + idLen.len;
  // BindResponse [APPLICATION 1] = 0x61.
  if (buf[off] !== 0x61) return null;
  const brLen = readLength(buf, off + 1);
  if (!brLen) return null;
  off = brLen.off;
  // resultCode ENUMERATED — same wire shape as INTEGER, tag 0x0A.
  if (buf[off] !== 0x0a) return null;
  const rcLen = readLength(buf, off + 1);
  if (!rcLen || rcLen.len < 1) return null;
  let code = 0;
  for (let i = 0; i < rcLen.len; i++) {
    code = (code << 8) | buf[rcLen.off + i];
  }
  return code;
}

function readLength(buf: Buffer, at: number): { off: number; len: number } | null {
  if (at >= buf.length) return null;
  const first = buf[at];
  if (first < 0x80) return { off: at + 1, len: first };
  const n = first & 0x7f;
  if (n === 0 || at + 1 + n > buf.length) return null;
  let len = 0;
  for (let i = 0; i < n; i++) len = (len << 8) | buf[at + 1 + i];
  return { off: at + 1 + n, len };
}

async function probeLdap(probe: LdapProbe): Promise<ProbeAttempt> {
  // Without a bind DN, an LDAP probe is just a TCP probe.
  if (!probe.bindDn || !probe.bindPassword) {
    return probeTcp({ kind: 'tcp', host: probe.host, port: probe.port, timeoutMs: probe.timeoutMs });
  }
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const chunks: Buffer[] = [];
    const finalize = (r: ProbeAttempt) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(probe.timeoutMs);
    socket.once('timeout', () => finalize({ ok: false, reason: 'timeout', detail: `LDAP timeout after ${probe.timeoutMs}ms` }));
    socket.once('error', (err) => finalize({ ok: false, reason: 'network-error', detail: err.message }));
    socket.once('connect', () => {
      socket.write(buildBindRequest(probe.bindDn!, probe.bindPassword!));
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      // Try to parse on every chunk — a full BindResponse is typically <100
      // bytes and arrives in one TCP segment.
      const result = parseBindResult(Buffer.concat(chunks));
      if (result === null) return;
      if (result === 0) {
        finalize({ ok: true, reason: null, detail: `bind succeeded as ${probe.bindDn}` });
      } else {
        finalize({
          ok: false,
          reason: 'unexpected-response',
          detail: `bind rejected (LDAP resultCode ${result}${result === 49 ? ' / invalidCredentials' : result === 52 ? ' / unavailable' : ''})`,
        });
      }
    });
    socket.connect(probe.port, probe.host);
  });
}

/* ─── Command (via agent) ──────────────────────────────────────────────── */

interface CommandProbeContext {
  /** Install target node (defaults to "Local" when undefined). */
  node?: string;
  /** Pod name — `kind: command` probes targeting a container inside this
   *  pod prefix the command with `podman exec <pod>-<container>`. */
  podName: string;
}

async function probeCommand(
  probe: CommandProbe,
  ctx: CommandProbeContext,
): Promise<ProbeAttempt> {
  const cmd = probe.container
    ? `podman exec ${ctx.podName}-${probe.container} sh -c ${JSON.stringify(probe.command)}`
    : probe.command;
  try {
    const agent = await agentManager.ensureAgent(ctx.node ?? 'Local');
    const res = await agent.sendCommand(
      'exec',
      { command: cmd },
      { timeoutMs: probe.timeoutMs },
    );
    const exit = typeof res?.exit_code === 'number' ? res.exit_code
      : typeof res?.exitCode === 'number' ? res.exitCode
      : (res?.stderr && !res?.stdout) ? 1 : 0;
    const expected = probe.expectExit ?? 0;
    if (exit === expected) {
      return { ok: true, reason: null, detail: `command exited ${exit}` };
    }
    const stderrTail = typeof res?.stderr === 'string'
      ? res.stderr.trim().split('\n').slice(-1)[0]
      : '';
    return {
      ok: false,
      reason: 'unexpected-response',
      detail: `command exited ${exit} (expected ${expected})${stderrTail ? `: ${stderrTail}` : ''}`,
    };
  } catch (e) {
    return {
      ok: false,
      reason: 'network-error',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/* ─── Dispatch ─────────────────────────────────────────────────────────── */

export interface ProbeContext {
  node?: string;
  podName: string;
}

export async function runProbe(probe: ReadinessProbe, ctx: ProbeContext): Promise<ProbeAttempt> {
  switch (probe.kind) {
    case 'http':    return probeHttp(probe);
    case 'tcp':     return probeTcp(probe);
    case 'ldap':    return probeLdap(probe);
    case 'command': return probeCommand(probe, ctx);
  }
}
