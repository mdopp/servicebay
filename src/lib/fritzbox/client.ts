import { PortMapping, FritzBoxStatus } from './types';

export class FritzBoxClient {
  private host: string;
  private port: number;
  private serviceType = 'urn:schemas-upnp-org:service:WANIPConnection:1';
  private controlUrl = '/igdupnp/control/WANIPConn1';

  constructor(host: string = 'fritz.box', port: number = 49000) {
    this.host = host;
    this.port = port;
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
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'SoapAction': `${this.serviceType}#${action}`
        },
        body: soapBody,
        signal: controller.signal
      });

      if (!res.ok) {
        if (res.status === 500) {
            // Check for specific UPnP errors if needed
            const text = await res.text();
            if (text.includes('NoSuchEntryInArray')) return null; // End of list
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
    const statusXml = await this.soapRequest('GetStatusInfo');
    if (!statusXml) throw new Error('Failed to get status');

    const connectionStatus = this.extractValue(statusXml, 'NewConnectionStatus');
    const uptimeStr = this.extractValue(statusXml, 'NewUptime');
    const uptime = uptimeStr ? parseInt(uptimeStr, 10) : 0;

    // Get External IP
    const ipXml = await this.soapRequest('GetExternalIPAddress');
    const externalIP = ipXml ? this.extractValue(ipXml, 'NewExternalIPAddress') || '' : '';

    // Get Port Mappings
    const portMappings: PortMapping[] = [];
    let index = 0;
    
    while (true) {
      try {
        const mappingXml = await this.soapRequest('GetGenericPortMappingEntry', { NewPortMappingIndex: index });
        if (!mappingXml) break; // End of list or error

        portMappings.push({
          remoteHost: this.extractValue(mappingXml, 'NewRemoteHost') || '',
          externalPort: parseInt(this.extractValue(mappingXml, 'NewExternalPort') || '0', 10),
          protocol: (this.extractValue(mappingXml, 'NewProtocol') || 'TCP') as 'TCP' | 'UDP',
          internalPort: parseInt(this.extractValue(mappingXml, 'NewInternalPort') || '0', 10),
          internalClient: this.extractValue(mappingXml, 'NewInternalClient') || '',
          enabled: this.extractValue(mappingXml, 'NewEnabled') === '1',
          description: this.extractValue(mappingXml, 'NewPortMappingDescription') || '',
          leaseDuration: parseInt(this.extractValue(mappingXml, 'NewLeaseDuration') || '0', 10),
        });

        index++;
        // Safety break
        if (index > 100) break;
      } catch {
        break;
      }
    }

    return {
      connected: connectionStatus === 'Connected',
      externalIP,
      uptime,
      portMappings
    };
  }
}
