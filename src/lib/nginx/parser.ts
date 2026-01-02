import fs from 'fs/promises';
import path from 'path';
import { NginxConfig, NginxServerBlock, NginxLocation } from './types';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Simple tokenizer
const tokenize = (input: string) => {
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  let isComment = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (isComment) {
      if (char === '\n') isComment = false;
      continue;
    }

    if (char === '#') {
      isComment = true;
      continue;
    }

    if (inQuote) {
      if (char === quoteChar && input[i - 1] !== '\\') {
        inQuote = false;
        tokens.push(current);
        current = '';
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inQuote = true;
      quoteChar = char;
      continue;
    }

    if (['{', '}', ';'].includes(char)) {
      if (current.trim()) tokens.push(current.trim());
      tokens.push(char);
      current = '';
      continue;
    }

    if (/\s/.test(char)) {
      if (current.trim()) {
        tokens.push(current.trim());
        current = '';
      }
      continue;
    }

    current += char;
  }
  
  if (current.trim()) tokens.push(current.trim());
  return tokens;
};

export class NginxParser {
  private rootDir: string;
  private containerId?: string;

  constructor(rootDir: string = '/etc/nginx', containerId?: string) {
    this.rootDir = rootDir;
    this.containerId = containerId;
  }

  async parse(): Promise<NginxConfig> {
    const mainConfigPath = path.join(this.rootDir, 'nginx.conf');
    console.log(`[NginxParser] Parsing config from: ${mainConfigPath}`);
    const servers: NginxServerBlock[] = [];
    
    try {
      await this.parseFile(mainConfigPath, servers);
    } catch (e) {
      console.warn(`Failed to parse nginx config at ${mainConfigPath}:`, e);
    }

    return { servers };
  }

  private async parseFile(filePath: string, servers: NginxServerBlock[]) {
    console.log(`[NginxParser] Reading file: ${filePath}`);
    let content = '';
    try {
      if (this.containerId) {
        const { stdout } = await execAsync(`podman exec ${this.containerId} cat ${filePath}`);
        content = stdout;
      } else {
        content = await fs.readFile(filePath, 'utf-8');
      }
      console.log(`[NginxParser] File content length: ${content.length}`);
    } catch (e) {
      console.warn(`[NginxParser] Failed to read file ${filePath}:`, e);
      return; // File not found or not readable
    }

    const tokens = tokenize(content);
    console.log(`[NginxParser] Tokenized ${tokens.length} tokens:`, JSON.stringify(tokens));
    let i = 0;

    const parseBlock = async (context: 'main' | 'http' | 'server' | 'location', currentServer?: NginxServerBlock, currentLocation?: NginxLocation) => {
      while (i < tokens.length) {
        const token = tokens[i];
        
        if (token === '}') {
          i++;
          return;
        }

        if (token === 'include') {
          i++;
          const pattern = tokens[i]; // e.g. /etc/nginx/conf.d/*.conf
          console.log(`[NginxParser] Found include: ${pattern}`);
          i++; // skip pattern
          if (tokens[i] === ';') i++; // skip ;
          
          // Resolve pattern
          // If relative, make absolute to rootDir (or current file dir? Nginx is usually relative to prefix, let's assume absolute or relative to /etc/nginx)
          let globPattern = pattern;
          if (!path.isAbsolute(pattern)) {
            globPattern = path.join(this.rootDir, pattern);
          } else if (!this.containerId && this.rootDir !== '/etc/nginx' && pattern.startsWith('/etc/nginx/')) {
            // Rebase /etc/nginx paths to rootDir if running locally with custom root
            globPattern = path.join(this.rootDir, pattern.replace('/etc/nginx/', ''));
          }

          // Simple glob expansion (only * supported for now to avoid deps)
          // Actually, let's just try to list the dir if it ends in *.conf
          if (globPattern.includes('*')) {
             const dir = path.dirname(globPattern);
             const ext = path.extname(globPattern); // .conf
             console.log(`[NginxParser] expanding glob: ${globPattern} in dir: ${dir}`);
             try {
                let files: string[] = [];
                if (this.containerId) {
                    const { stdout } = await execAsync(`podman exec ${this.containerId} ls ${dir}`);
                    files = stdout.split('\n').map(f => f.trim()).filter(f => f);
                } else {
                    files = await fs.readdir(dir);
                }
                
                console.log(`[NginxParser] found files: ${files.join(', ')}`);

                for (const f of files) {
                    if (f.endsWith(ext)) {
                        console.log(`[NginxParser] parsing included file: ${path.join(dir, f)}`);
                        await this.parseFile(path.join(dir, f), servers);
                    }
                }
             } catch (e) {
                 console.error(`[NginxParser] failed to expand glob:`, e);
             }
          } else {
             await this.parseFile(globPattern, servers);
          }
          continue;
        }

        if (token === 'http') {
          i++; // skip http
          if (tokens[i] === '{') {
            i++;
            await parseBlock('http');
          }
          continue;
        }

        if (token === 'server') {
          i++; // skip server
          if (tokens[i] === '{') {
            i++;
            const newServer: NginxServerBlock = {
              id: filePath + ':' + i,
              filePath,
              listen: [],
              server_name: [],
              locations: []
            };
            await parseBlock('server', newServer);
            servers.push(newServer);
          }
          continue;
        }

        if (token === 'location') {
          i++; // skip location
          const pathVal = tokens[i];
          i++; // skip path
          if (tokens[i] === '{') {
            i++;
            const newLocation: NginxLocation = {
              path: pathVal,
              directives: {}
            };
            await parseBlock('location', currentServer, newLocation);
            if (currentServer) currentServer.locations.push(newLocation);
          }
          continue;
        }

        // Generic block handler (e.g. events, types)
        if (tokens[i + 1] === '{') {
            console.log(`[NginxParser] Skipping generic block: ${token}`);
            i += 2; // skip name and {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await parseBlock('unknown' as any);
            continue;
        }

        // Directives
        const directive = token;
        i++;
        const args: string[] = [];
        while (i < tokens.length && tokens[i] !== ';' && tokens[i] !== '{' && tokens[i] !== '}') {
          args.push(tokens[i]);
          i++;
        }
        
        if (tokens[i] === ';') i++;

        if (context === 'server' && currentServer) {
          if (directive === 'listen') currentServer.listen.push(args.join(' '));
          if (directive === 'server_name') currentServer.server_name.push(...args);
          if (directive === 'ssl_certificate') currentServer.ssl_certificate = args[0];
          if (directive === 'ssl_certificate_key') currentServer.ssl_certificate_key = args[0];
        }

        if (context === 'location' && currentLocation) {
          if (directive === 'proxy_pass') currentLocation.proxy_pass = args[0];
          if (directive === 'root') currentLocation.root = args[0];
          if (directive === 'index') currentLocation.index = args;
          currentLocation.directives[directive] = args.join(' ');
        }
      }
    };

    await parseBlock('main');
  }
}
