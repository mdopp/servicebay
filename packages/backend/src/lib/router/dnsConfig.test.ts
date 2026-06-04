/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// dnsConfig pulls the FritzBox client + digest helper transitively; stub the
// digest fetch so a `reconnect` path never hits the network in these tests.
vi.mock('@/lib/fritzbox/digest', () => ({
  fetchWithDigest: vi.fn(),
}));

let configValue: any = {
  gateway: { type: 'fritzbox', host: '192.168.1.1', username: 'admin', password: 'secret' },
  reverseProxy: { lanIp: '192.168.1.10' },
};
vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(configValue)),
}));

import {
  parseSoapFault,
  classifyTr064WriteFailure,
  setFritzBoxDhcpDns,
  setFritzBoxWanDns,
} from './dnsConfig';

const FAULT_401 = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
<errorCode>401</errorCode><errorDescription>Invalid Action</errorDescription>
</UPnPError></detail></s:Fault></s:Body></s:Envelope>`;

const FAULT_501 = `<s:Fault><detail><UPnPError><errorCode>501</errorCode><errorDescription>Action Failed</errorDescription></UPnPError></detail></s:Fault>`;

const FAULT_GENERIC = `<s:Fault><detail><UPnPError><errorCode>713</errorCode><errorDescription>SpecifiedArrayIndexInvalid</errorDescription></UPnPError></detail></s:Fault>`;

beforeEach(() => {
  vi.restoreAllMocks();
  configValue = {
    gateway: { type: 'fritzbox', host: '192.168.1.1', username: 'admin', password: 'secret' },
    reverseProxy: { lanIp: '192.168.1.10' },
  };
});

describe('parseSoapFault', () => {
  it('extracts errorCode + errorDescription from an AVM UPnP fault', () => {
    expect(parseSoapFault(FAULT_401)).toEqual({ errorCode: 401, errorDescription: 'Invalid Action' });
  });

  it('returns null for a non-fault body (HTML error page)', () => {
    expect(parseSoapFault('<html><body>500 Internal Server Error</body></html>')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseSoapFault('')).toBeNull();
  });
});

describe('classifyTr064WriteFailure', () => {
  it('treats UPnP 401 (Invalid Action) as unsupported → manual DNS success', () => {
    const r = classifyTr064WriteFailure(500, FAULT_401, 'Set DNS manually.');
    expect(r.result).toBe('unsupported');
    expect(r.detail).toMatch(/UPnP 401/);
    expect(r.detail).toMatch(/Invalid Action/);
    expect(r.detail).toMatch(/Set DNS manually/);
  });

  it('treats UPnP 501 (Action Failed) as unsupported', () => {
    expect(classifyTr064WriteFailure(500, FAULT_501, 'manual').result).toBe('unsupported');
  });

  it('surfaces the actual SOAP fault on a real (non-unsupported) failure', () => {
    const r = classifyTr064WriteFailure(500, FAULT_GENERIC, 'manual hint');
    expect(r.result).toBe('failed');
    expect(r.detail).toMatch(/713/);
    expect(r.detail).toMatch(/SpecifiedArrayIndexInvalid/);
    expect(r.detail).toMatch(/manual hint/);
  });

  it('does not assert "TR-064 disabled or credentials wrong" when no fault is parseable', () => {
    const r = classifyTr064WriteFailure(500, '<html>oops</html>', 'manual hint');
    expect(r.result).toBe('failed');
    expect(r.detail).not.toMatch(/credentials are wrong/);
    expect(r.detail).toMatch(/manual hint/);
  });
});

describe('setFritzBoxDhcpDns — model where SetDNSServers is unsupported', () => {
  it('returns unsupported (treat manual as success) on a UPnP 401 fault', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => FAULT_401,
    } as any);
    const r = await setFritzBoxDhcpDns('192.168.1.10');
    expect(r.result).toBe('unsupported');
    expect(r.detail).toMatch(/manually/);
  });

  it('bare HTTP 401 with no SOAP fault stays a credentials error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as any);
    const r = await setFritzBoxDhcpDns('192.168.1.10');
    expect(r.result).toBe('no_credentials');
  });
});

describe('setFritzBoxWanDns — unsupported model', () => {
  it('returns unsupported when both WAN services fault with UPnP 501', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => FAULT_501,
    } as any);
    const r = await setFritzBoxWanDns('192.168.1.10');
    expect(r.result).toBe('unsupported');
  });
});
