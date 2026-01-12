import { PortMapping, FritzBoxStatus } from './types';
import * as dns from 'dns/promises';
import { fetchWithDigest } from './digest';
import crypto from 'crypto';
import { logger } from '@/lib/logger';

export interface FritzBoxOptions {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
}

export class FritzBoxClient {
  private static discoveryCache = new Map<string, Map<string, string>>();

  private host: string;
  private port: number;
  private username?: string;
  private password?: string;
  private serviceDetected = false;
  private services = new Map<string, string>();
  
  // Default to UPnP IGD (Unauthenticated)
  private serviceType = 'urn:schemas-upnp-org:service:WANIPConnection:1';
  private controlUrl = '/igdupnp/control/WANIPConn1';

  constructor(options: FritzBoxOptions = {}) {
    this.host = options.host || 'fritz.box';
    this.port = options.port || 49000;
    this.username = options.username;
    this.password = options.password;

    if (this.username && this.password) {
        // Switch to TR-064 (Authenticated)
        this.serviceType = 'urn:dslforum-org:service:WANIPConnection:1';
        this.controlUrl = '/upnp/control/wanipconnection1';
    }
  }

  private async discoverServices() {
    if (this.services.size > 0) return;

    const cacheKey = `${this.host}:${this.port}`;
    if (FritzBoxClient.discoveryCache.has(cacheKey)) {
        this.services = new Map(FritzBoxClient.discoveryCache.get(cacheKey)!);
        return;
    }

    try {
      const url = `http://${this.host}:${this.port}/tr64desc.xml`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch TR-64 desc: ${res.status}`);
      const xml = await res.text();

      // Simple regex parser for services
      const serviceRegex = /<service>([\s\S]*?)<\/service>/g;
      let match;
      
      while ((match = serviceRegex.exec(xml)) !== null) {
        const content = match[1];
        const typeMatch = content.match(/<serviceType>(.*?)<\/serviceType>/);
        const urlMatch = content.match(/<controlURL>(.*?)<\/controlURL>/);
        
        if (typeMatch && urlMatch) {
          const type = typeMatch[1].trim();
          const url = urlMatch[1].trim();
          this.services.set(type, url);
        }
      }
      
      if (this.services.size > 0) {
          FritzBoxClient.discoveryCache.set(cacheKey, new Map(this.services));
      }

      logger.info('FritzBox', `Discovered ${this.services.size} services via TR-64`);
    } catch (e) {
      logger.warn('FritzBox', 'Service discovery failed:', e);
    }
  }

  private async detectServiceType() {
      if (this.serviceDetected) return;

      // Try discovery first
      await this.discoverServices();

      if (!this.username || !this.password) {
          // console.log('[FritzBox] No credentials provided, skipping service detection (using default UPnP)');
          return; 
      }

      // Check for preferred services in discovered list
      const preferred = [
          'urn:dslforum-org:service:WANPPPConnection:1',
          'urn:dslforum-org:service:WANIPConnection:1'
      ];

      for (const type of preferred) {
          if (this.services.has(type)) {
              this.serviceType = type;
              this.controlUrl = this.services.get(type)!;
              this.serviceDetected = true;
              logger.info('FritzBox', `Auto-configured service: ${this.serviceType}`);
              return;
          }
      }

      // console.log('[FritzBox] Detecting service type (fallback)...');

      // Try WANIPConnection first
      try {
          this.serviceType = 'urn:dslforum-org:service:WANIPConnection:1';
          this.controlUrl = '/upnp/control/wanipconnection1';
          // console.log(`[FritzBox] Testing ${this.serviceType}...`);
          await this.soapRequest('GetInfo', {}, undefined, undefined, true);
          // console.log(`[FritzBox] Success: Using ${this.serviceType}`);
          this.serviceDetected = true;
          return; // It works
      } catch {
        // console.log(`[FritzBox] Failed ${this.serviceType}:`, e instanceof Error ? e.message : e);
      }

      // Try WANPPPConnection
      this.serviceType = 'urn:dslforum-org:service:WANPPPConnection:1';
      this.controlUrl = '/upnp/control/wanpppconn1';
      
      try {
          // console.log(`[FritzBox] Testing ${this.serviceType}...`);
          await this.soapRequest('GetInfo', {}, undefined, undefined, true);
          // console.log(`[FritzBox] Success: Using ${this.serviceType}`);
          this.serviceDetected = true;
          return; // It works
      } catch {
          // console.log(`[FritzBox] Failed ${this.serviceType}:`, e instanceof Error ? e.message : e);
          
          // Reset to IP if both fail, or handle error
          logger.info('FritzBox', 'All authenticated services failed, falling back to default WANIPConnection:1');
          this.serviceType = 'urn:dslforum-org:service:WANIPConnection:1';
          this.controlUrl = '/upnp/control/wanipconnection1';
      }
  }

  private async soapRequest(action: string, args: Record<string, string | number> = {}, serviceTypeOverride?: string, controlUrlOverride?: string, silent: boolean = false) {
    const serviceType = serviceTypeOverride || this.serviceType;
    let controlUrl = controlUrlOverride || this.controlUrl;

    // If we have a specific service type requested but no control URL, try to find it in discovered services
    if (serviceTypeOverride && !controlUrlOverride && this.services.has(serviceTypeOverride)) {
        controlUrl = this.services.get(serviceTypeOverride)!;
    }

    const url = `http://${this.host}:${this.port}${controlUrl}`;
    
    let argsXml = '';
    for (const [key, value] of Object.entries(args)) {
      argsXml += `<${key}>${value}</${key}>`;
    }

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
<s:Body>
<u:${action} xmlns:u="${serviceType}">
${argsXml}
</u:${action}>
</s:Body>
</s:Envelope>`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const options: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'SoapAction': `${serviceType}#${action}`
        },
        body: soapBody,
        signal: controller.signal
      };

      let res: Response;
      if (this.username && this.password) {
          res = await fetchWithDigest(url, options, { username: this.username, password: this.password });
      } else {
          res = await fetch(url, options);
      }

      if (!res.ok) {
        if (res.status === 500) {
            // Check for specific UPnP errors if needed
            const text = await res.text();
            if (text.includes('NoSuchEntryInArray') || text.includes('SpecifiedArrayIndexInvalid')) return null; // End of list
            
            // Log other 500 errors for debugging
            if (!silent) console.warn(`FritzBox SOAP 500 Error for ${action}:`, text);
        }
        throw new Error(`SOAP Error ${res.status}: ${res.statusText}`);
      }

      const text = await res.text();
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractValue(xml: string, tag: string): string | null {
    const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
    return match ? match[1] : null;
  }

  private sid?: string;

  private async getSID(): Promise<string> {
    if (this.sid) return this.sid;

    // Lua interface is on port 80 (Web UI), not TR-064 port (49000)
    const loginUrl = `http://${this.host}/login_sid.lua`;
    
    try {
        const res = await fetch(loginUrl);
        const xml = await res.text();
        const challenge = this.extractValue(xml, 'Challenge');
        
        if (!challenge) throw new Error('No challenge found');

        const cpstr = `${challenge}-${this.password}`;
        const buffer = Buffer.from(cpstr, 'utf16le');
        const md5 = crypto.createHash('md5').update(buffer).digest('hex');
        const response = `${challenge}-${md5}`;

        const sidRes = await fetch(`${loginUrl}?username=${this.username}&response=${response}`);
        const sidXml = await sidRes.text();
        const sid = this.extractValue(sidXml, 'SID');

        if (!sid || sid === '0000000000000000') {
            throw new Error('Login failed (Invalid SID)');
        }

        this.sid = sid;
        return sid;
    } catch (e) {
        console.warn('[FritzBox] Lua Login failed:', e);
        throw e;
    }
  }

  private async getLuaDNS(): Promise<string | null> {
      if (!this.username || !this.password) return null;

      try {
          const sid = await this.getSID();
          const url = `http://${this.host}/data.lua`;
          
          const params = new URLSearchParams();
          params.append('sid', sid);
          params.append('xhr', '1');
          params.append('query', 'queries:connection0:status/connect/ipv4');

          const res = await fetch(url, {
              method: 'POST',
              body: params
          });
          
          const json = await res.json();
          
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const findKey = (obj: any, key: string): any => {
              if (typeof obj !== 'object' || obj === null) return undefined;
              if (key in obj) return obj[key];
              for (const k in obj) {
                  const result = findKey(obj[k], key);
                  if (result) return result;
              }
              return undefined;
          };

          const dnsArr = findKey(json, 'dns');
          if (Array.isArray(dnsArr) && dnsArr.length > 0) {
              return dnsArr[0]?.ip || null;
          }
          
          return null;
      } catch (e) {
          console.warn('[FritzBox] Failed to get Lua DNS:', e);
          return null;
      }
  }

  private async getDeviceLog(): Promise<string | null> {
      // Try TR-064 first (DeviceInfo:1)
      try {
          if (this.username && this.password) {
             const logUrl = await this.soapRequest('GetDeviceLog', {}, 'urn:dslforum-org:service:DeviceInfo:1', '/upnp/control/deviceinfo', true);
             if (logUrl) {
                 const url = this.extractValue(logUrl, 'NewDeviceLog');
                 if (url) {
                     const res = await fetch(url);
                     if (res.ok) return await res.text();
                 }
             }
          }
      } catch {
          // console.warn('[FritzBox] TR-064 GetDeviceLog failed:', e);
      }

      // Fallback to Lua
      if (!this.username || !this.password) return null;

      try {
          const sid = await this.getSID();
          const url = `http://${this.host}/data.lua`;
          
          const params = new URLSearchParams();
          params.append('sid', sid);
          params.append('xhr', '1');
          params.append('query', 'queries:log:status/log');

          const res = await fetch(url, {
              method: 'POST',
              body: params
          });
          
          const json = await res.json();
          
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const findKey = (obj: any, key: string): any => {
              if (typeof obj !== 'object' || obj === null) return undefined;
              if (key in obj) return obj[key];
              for (const k in obj) {
                  const result = findKey(obj[k], key);
                  if (result) return result;
              }
              return undefined;
          };

          const logArr = findKey(json, 'log');
          if (Array.isArray(logArr)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return logArr.map((entry: any) => `${entry.date} ${entry.time} - ${entry.msg}`).join('\n');
          }
          
          return null;
      } catch (e) {
          console.warn('[FritzBox] Lua GetDeviceLog failed:', e);
          return null;
      }
  }

  async getStatus(): Promise<FritzBoxStatus> {
    await this.detectServiceType();

    const statusXml = await this.soapRequest('GetStatusInfo');
    if (!statusXml) throw new Error('Failed to get status');

    const connectionStatus = this.extractValue(statusXml, 'NewConnectionStatus');
    const uptimeStr = this.extractValue(statusXml, 'NewUptime');
    const uptime = uptimeStr ? parseInt(uptimeStr, 10) : 0;

    // Get External IP
    const ipXml = await this.soapRequest('GetExternalIPAddress');
    const externalIP = ipXml ? this.extractValue(ipXml, 'NewExternalIPAddress') || '' : '';

    // Get Internal IP (Resolve Hostname)
    let internalIP = '';
    try {
        const lookup = await dns.lookup(this.host);
        internalIP = lookup.address;
    } catch (e) {
        logger.warn('FritzBox', 'Failed to resolve FritzBox hostname', e);
    }

    // Get DNS Servers
    let dnsServers: string[] = [];
    try {
        // 0. Try Lua Interface (Most accurate for Upstream DNS)
        const luaDns = await this.getLuaDNS();
        if (luaDns) {
            dnsServers.push(luaDns);
        }

        // 1. Try GetInfo (WAN)
        // console.log('[FritzBox] Fetching DNS servers via GetInfo...');
        const infoXml = await this.soapRequest('GetInfo');
        if (infoXml) {
            // console.log('[FritzBox] GetInfo Response:', infoXml);
            const dnsStr = this.extractValue(infoXml, 'NewDNSServers');
            // console.log('[FritzBox] Extracted NewDNSServers:', dnsStr);
            if (dnsStr) {
                const servers = dnsStr.split(',').map(s => s.trim()).filter(s => s);
                dnsServers.push(...servers);
            }
        }

        // 2. Try X_AVM-DE_GetDNSServer (WAN) - if available
        try {
             const avmDnsXml = await this.soapRequest('X_AVM-DE_GetDNSServer', {}, undefined, undefined, true);
             if (avmDnsXml) {
                 // console.log('[FritzBox] X_AVM-DE_GetDNSServer Response:', avmDnsXml);
                 const v4 = this.extractValue(avmDnsXml, 'NewIPv4DNSServer1');
                 const v4_2 = this.extractValue(avmDnsXml, 'NewIPv4DNSServer2');
                 if (v4) dnsServers.push(v4);
                 if (v4_2) dnsServers.push(v4_2);
             }
        } catch {
            // If failed on the detected service, try the alternative WAN service
            const altService = this.serviceType.includes('PPP') 
                ? 'urn:dslforum-org:service:WANIPConnection:1' 
                : 'urn:dslforum-org:service:WANPPPConnection:1';
            
            if (this.services.has(altService)) {
                try {
                    const avmDnsXml = await this.soapRequest('X_AVM-DE_GetDNSServer', {}, altService, undefined, true);
                    if (avmDnsXml) {
                         logger.info('FritzBox', `Found DNS on alternative service: ${altService}`);
                         const v4 = this.extractValue(avmDnsXml, 'NewIPv4DNSServer1');
                         const v4_2 = this.extractValue(avmDnsXml, 'NewIPv4DNSServer2');
                         if (v4) dnsServers.push(v4);
                         if (v4_2) dnsServers.push(v4_2);
                    }
                } catch {
                    // Ignore
                }
            }
        }

        // 3. Try LANHostConfigManagement (LAN)
        try {
            const lanDnsXml = await this.soapRequest(
                'GetDNSServers', 
                {}, 
                'urn:dslforum-org:service:LANHostConfigManagement:1', 
                undefined,
                true
            );
            if (lanDnsXml) {
                // console.log('[FritzBox] LANHostConfigManagement GetDNSServers Response:', lanDnsXml);
                const dnsStr = this.extractValue(lanDnsXml, 'NewDNSServers');
                if (dnsStr) {
                    const servers = dnsStr.split(',').map(s => s.trim()).filter(s => s);
                    // Add unique
                    servers.forEach(s => {
                        if (!dnsServers.includes(s)) dnsServers.push(s);
                    });
                }
            }
        } catch {
             // console.warn('[FritzBox] Failed to get LAN DNS servers:', e);
        }

        // Deduplicate
        dnsServers = Array.from(new Set(dnsServers));
        
        if (dnsServers.length > 0) {
            logger.info('FritzBox', `Found DNS Servers: ${dnsServers.join(', ')}`);
        } else {
            logger.warn('FritzBox', 'No DNS servers found via discover service.');
        }

    } catch (e) {
        logger.warn('FritzBox', `Failed to get DNS servers: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Get Port Mappings
    const portMappings: PortMapping[] = [];
    let index = 0;
    
    logger.info('FritzBox', 'Fetching port mappings...');
    while (true) {
      try {
        const mappingXml = await this.soapRequest('GetGenericPortMappingEntry', { NewPortMappingIndex: index });
        if (!mappingXml) break; // End of list or error

        const mapping = {
          remoteHost: this.extractValue(mappingXml, 'NewRemoteHost') || '',
          externalPort: parseInt(this.extractValue(mappingXml, 'NewExternalPort') || '0', 10),
          protocol: (this.extractValue(mappingXml, 'NewProtocol') || 'TCP') as 'TCP' | 'UDP',
          internalPort: parseInt(this.extractValue(mappingXml, 'NewInternalPort') || '0', 10),
          internalClient: this.extractValue(mappingXml, 'NewInternalClient') || '',
          enabled: this.extractValue(mappingXml, 'NewEnabled') === '1',
          description: this.extractValue(mappingXml, 'NewPortMappingDescription') || '',
          leaseDuration: parseInt(this.extractValue(mappingXml, 'NewLeaseDuration') || '0', 10),
        };
        
        portMappings.push(mapping);
        logger.info('FritzBox', `Found mapping: ${mapping.externalPort} -> ${mapping.internalClient}:${mapping.internalPort}`);

        index++;
        // Safety break
        if (index > 100) break;
      } catch {
        // console.warn('Error fetching mapping at index', index, e);
        break;
      }
    }
    logger.info('FritzBox', `Total mappings found: ${portMappings.length}`);

    // Get Device Log
    const deviceLog = await this.getDeviceLog() || undefined;

    return {
      connected: connectionStatus === 'Connected',
      externalIP,
      internalIP, // Add to return type
      uptime,
      portMappings,
      dnsServers,
      deviceLog
    };
  }
}
