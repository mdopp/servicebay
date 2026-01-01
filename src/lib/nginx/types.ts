export interface NginxConfig {
  servers: NginxServerBlock[];
}

export interface NginxServerBlock {
  id: string; // Unique ID (file path + index?)
  filePath: string;
  listen: string[]; // e.g. ["80", "443 ssl"]
  server_name: string[]; // e.g. ["example.com", "*.example.com"]
  locations: NginxLocation[];
  ssl_certificate?: string;
  ssl_certificate_key?: string;
}

export interface NginxLocation {
  path: string; // e.g. "/" or "/api"
  proxy_pass?: string; // e.g. "http://localhost:3000"
  root?: string;
  index?: string[];
  directives: Record<string, string>; // Other directives like proxy_set_header
}
