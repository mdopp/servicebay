import fs from 'fs/promises';
import path from 'path';
import { NginxConfig, NginxServerBlock, NginxLocation } from './types';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Executor } from '../executor';

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
      if (current.trim()) {
          // If we have text before the quote (e.g. prefix"quoted"), push it?
          // Nginx usually separates by space.
          // But if we have `server_name "foo" "bar";`
          // `current` is empty (due to space handling).
          // If `server_name foo"bar";` -> `foo` is in current.
          // Let's push current if it exists.
          tokens.push(current.trim());
          current = '';
      }
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
  private executor?: Executor;
  private sysRoot?: string;

  constructor(rootDir: string = '/etc/nginx', containerId?: string, executor?: Executor, sysRoot?: string) {
    this.rootDir = rootDir;
    this.containerId = containerId;
    this.executor = executor;
    this.sysRoot = sysRoot;
  }

  async parse(): Promise<NginxConfig> {
    let mainConfigPath = path.join(this.rootDir, 'nginx.conf');
    if (this.sysRoot) {
        mainConfigPath = path.join(this.sysRoot, mainConfigPath);
    }
    // console.log(`[NginxParser] Parsing config from: ${mainConfigPath}`);
    const servers: NginxServerBlock[] = [];
    
    try {
      await this.parseFile(mainConfigPath, servers);
    } catch (e) {
      console.warn(`Failed to parse nginx config at ${mainConfigPath}:`, e);
    }

    return { servers };
  }

  private async parseFile(filePath: string, servers: NginxServerBlock[]) {
    // console.log(`[NginxParser] Reading file: ${filePath}`);
    let content = '';
    try {
      if (this.executor) {
        if (this.containerId) {
            const { stdout } = await this.executor.exec(`podman exec ${this.containerId} cat ${filePath}`);
            content = stdout;
        } else {
            content = await this.executor.readFile(filePath);
        }
      } else if (this.containerId) {
        const { stdout } = await execAsync(`podman exec ${this.containerId} cat ${filePath}`);
        content = stdout;
      } else {
        content = await fs.readFile(filePath, 'utf-8');
      }
      // console.log(`[NginxParser] File content length: ${content.length}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e.message && (e.message.includes('container state improper') || e.message.includes('not running'))) {
        return;
      }
      console.warn(`[NginxParser] Failed to read file ${filePath}:`, e);
      return; // File not found or not readable
    }

    const tokens = tokenize(content);
    // console.log(`[NginxParser] Tokenized ${tokens.length} tokens:`, JSON.stringify(tokens));
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
          // console.log(`[NginxParser] Found include: ${pattern}`);
          i++; // skip pattern
          if (tokens[i] === ';') i++; // skip ;
          
          // Resolve pattern
          // If relative, make absolute to rootDir
          let globPattern = pattern;
          if (!path.isAbsolute(pattern)) {
            globPattern = path.join(this.rootDir, pattern);
          }
          
          // Apply sysRoot or custom root remapping
          if (this.sysRoot) {
            // Rebase absolute path to sysRoot
            // e.g. /etc/nginx/x -> /tmp/sysroot/etc/nginx/x
            globPattern = path.join(this.sysRoot, globPattern);
          } else if (!this.containerId && this.rootDir !== '/etc/nginx' && pattern.startsWith('/etc/nginx/')) {
            // Rebase /etc/nginx paths to rootDir if running locally with custom root
            globPattern = path.join(this.rootDir, pattern.replace('/etc/nginx/', ''));
          }

          // Simple glob expansion
          // We check for *, ?, or [] which indicate a glob pattern
          if (globPattern.includes('*') || globPattern.includes('?') || (globPattern.includes('[') && globPattern.includes(']'))) {
             const dir = path.dirname(globPattern);
             // We can't rely on extname if the pattern is complex, but for now let's try to match loosely
             // If we have a glob, we list the directory and try to match files
             // Since we don't have a full glob matcher, we'll just list all files in dir and try to match the pattern manually or just include all .conf files if it looks like an include
             
             // console.log(`[NginxParser] expanding glob: ${globPattern} in dir: ${dir}`);
             try {
                let files: string[] = [];
                if (this.executor) {
                    if (this.containerId) {
                        // Use ls -1 to ensure single column output and suppress stderr, force success
                        try {
                            const { stdout } = await this.executor.exec(`podman exec ${this.containerId} sh -c "ls -1 ${dir} 2>/dev/null || true"`);
                            files = stdout.split('\n').map(f => f.trim()).filter(f => f);
                        } catch (e) {
                            console.warn(`[NginxParser] Failed to list files in ${dir} inside container ${this.containerId}`, e);
                        }
                    } else {
                        files = await this.executor.readdir(dir);
                    }
                } else if (this.containerId) {
                    try {
                        const { stdout } = await execAsync(`podman exec ${this.containerId} sh -c "ls -1 ${dir} 2>/dev/null || true"`);
                        files = stdout.split('\n').map(f => f.trim()).filter(f => f);
                    } catch (e) {
                        console.warn(`[NginxParser] Failed to list files in ${dir} inside container ${this.containerId}`, e);
                    }
                } else {
                    try {
                        files = await fs.readdir(dir);
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    } catch (e: any) {
                        if (e.code !== 'ENOENT') {
                            console.warn(`[NginxParser] Failed to readdir ${dir}:`, e);
                        }
                        files = [];
                    }
                }
                
                // console.log(`[NginxParser] found files: ${files.join(', ')}`);

                // Simple matcher: if pattern ends in .conf, include all .conf files
                // If pattern contains [.]conf, it matches .conf
                // This is a hack, but avoids adding 'glob' dependency for now
                const isConf = globPattern.endsWith('.conf') || globPattern.endsWith('[.]conf');

                for (const f of files) {
                    if (isConf && f.endsWith('.conf')) {
                        // console.log(`[NginxParser] parsing included file: ${path.join(dir, f)}`);
                        await this.parseFile(path.join(dir, f), servers);
                    }
                }
             } catch (e) {
                 console.error(`[NginxParser] failed to expand glob:`, e);
             }
          } else {
             try {
                await this.parseFile(globPattern, servers);
             } catch (e) {
                console.warn(`[NginxParser] Failed to parse included file ${globPattern}:`, e);
             }
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
              locations: [],
              variables: {}
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
              directives: {},
              variables: {}
            };
            await parseBlock('location', currentServer, newLocation);
            if (currentServer) currentServer.locations.push(newLocation);
          }
          continue;
        }

        // Directives or Blocks
        const directive = token;
        i++;
        const args: string[] = [];
        while (i < tokens.length && tokens[i] !== ';' && tokens[i] !== '{' && tokens[i] !== '}') {
          args.push(tokens[i]);
          i++;
        }
        
        if (tokens[i] === '{') {
            // It's a block start
            // console.log(`[NginxParser] Entering block: ${directive} ${args.join(' ')}`);
            i++; // skip {
            // Recurse to skip/parse the block content
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await parseBlock('unknown' as any, currentServer, currentLocation);
            continue;
        }

        if (tokens[i] === ';') i++;

        // Handle set directive (variable assignment)
        if (directive === 'set' && args.length >= 2) {
            const key = args[0]; // e.g. $forward_scheme
            const value = args[1]; // e.g. http
            
            if (currentLocation) {
                if (!currentLocation.variables) currentLocation.variables = {};
                currentLocation.variables[key] = value;
            } else if (currentServer) {
                if (!currentServer.variables) currentServer.variables = {};
                currentServer.variables[key] = value;
            }
        }

        if (context === 'server' && currentServer) {
          if (directive === 'listen') currentServer.listen.push(args.join(' '));
          if (directive === 'server_name') {
              // Clean args (remove quotes if any remain, though tokenizer handles them)
              const cleanArgs = args.map(a => a.replace(/^['"]|['"]$/g, ''));
              currentServer.server_name.push(...cleanArgs);
          }
          if (directive === 'ssl_certificate') currentServer.ssl_certificate = args[0];
          if (directive === 'ssl_certificate_key') currentServer.ssl_certificate_key = args[0];
        }

        if (currentLocation) {
          if (directive === 'proxy_pass') {
              let val = args[0];
              // Resolve variables
              const vars = { ...(currentServer?.variables || {}), ...(currentLocation?.variables || {}) };
              
              // Simple substitution
              for (const [k, v] of Object.entries(vars)) {
                  if (val.includes(k)) {
                      val = val.replaceAll(k, v);
                  }
              }
              currentLocation.proxy_pass = val;
          }
          if (directive === 'root') currentLocation.root = args[0];
          if (directive === 'index') currentLocation.index = args;
          currentLocation.directives[directive] = args.join(' ');
        }
      }
    };

    await parseBlock('main');
  }
}
