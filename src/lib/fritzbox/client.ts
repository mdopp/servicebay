import { PortMapping, FritzBoxStatus } from './types';
import * as dns from 'dns/promises';
import { fetchWithDigest } from './digest';

export interface FritzBoxOptions {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
}

export class FritzBoxClient {
  private host: string;
  private port: number;
  private username?: string;
  private password?: string;
  
  // Default to UPnP IGD (Unauthenticated)
  private serviceType = 'urn:schemas-upnp-org:service:WANIPConnection:1';
  private controlUrl = '/igdupnp/control/WANIPConn1';

  constructor(options: FritzBoxOptions = {}) {
    this.host = options.host || 'fritz.box';
    this.port = options.port || 49000;
    this.username = options.username || process.env.FRITZBOX_USER;
    this.password = options.password || process.env.FRITZBOX_PASSWORD;

    if (this.username && this.password) {
        // Switch to TR-064 (Authenticated)
        this.serviceType = 'urn:dslforum-org:service:WANIPConnection:1';
        this.controlUrl = '/upnp/control/wanipconnection1';
    }
  }

  private async detectServiceType() {
      if (!this.username || !this.password) {
          console.log('[FritzBox] No credentials provided, skipping service detection (using default UPnP)');
          return; 
      }

      console.log('[FritzBox] Detecting service type...');

      // Try WANIPConnection first
      try {
          this.serviceType = 'urn:dslforum-org:service:WANIPConnection:1';
          this.controlUrl = '/upnp/control/wanipconnection1';
          console.log(`[FritzBox] Testing ${this.serviceType}...`);
          await this.soapRequest('GetInfo');
          console.log(`[FritzBox] Success: Using ${this.serviceType}`);
          return; // It works
      } catch (e) {
          console.log(`[FritzBox] Failed ${this.serviceType}:`, e instanceof Error ? e.message : e);
      }

      // Try WANPPPConnection
      this.serviceType = 'urn:dslforum-org:service:WANPPPConnection:1';
      this.controlUrl = '/upnp/control/wanpppconn1';
      
      try {
          console.log(`[FritzBox] Testing ${this.serviceType}...`);
          await this.soapRequest('GetInfo');
          console.log(`[FritzBox] Success: Using ${this.serviceType}`);
          return; // It works
      } catch (e) {
          console.log(`[FritzBox] Failed ${this.serviceType}:`, e instanceof Error ? e.message : e);
          
          // Reset to IP if both fail, or handle error
          console.log('[FritzBox] All authenticated services failed, falling back to default WANIPConnection:1');
          this.serviceType = 'urn:dslforum-org:service:WANIPConnection:1';
          this.controlUrl = '/upnp/control/wanipconnection1';
      }
  }

  private async soapRequest(action: string, args: Record<string, string | number> = {}) {
    const url = `http://${this.host}:${this.port}${this.controlUrl}`;
    
    let argsXml = '';
    for (const [key, value] of Object.entries(args)) {
      argsXml += `<${key}>${value}</${key}>`;
    }

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
<s:Body>
<u:${action} xmlns:u="${this.serviceType}">
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
          'SoapAction': `${this.serviceType}#${action}`
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
            console.warn(`FritzBox SOAP 500 Error for ${action}:`, text);
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
        console.warn('Failed to resolve FritzBox hostname', e);
    }

    // Get Port Mappings
    const portMappings: PortMapping[] = [];
    let index = 0;
    
    console.log('[FritzBox] Fetching port mappings...');
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
        console.log(`[FritzBox] Found mapping: ${mapping.externalPort} -> ${mapping.internalClient}:${mapping.internalPort}`);

        index++;
        // Safety break
        if (index > 100) break;
      } catch (e) {
        // console.warn('Error fetching mapping at index', index, e);
        break;
      }
    }
    console.log(`[FritzBox] Total mappings found: ${portMappings.length}`);

    return {
      connected: connectionStatus === 'Connected',
      externalIP,
      internalIP, // Add to return type
      uptime,
      portMappings
    };
  }
}
