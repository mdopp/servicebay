
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getExecutor } from '@/lib/executor';
import { listNodes } from '@/lib/nodes';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { agentManager } from '@/lib/agent/manager';
import { ServiceName } from '@/lib/api/schemas';
import { withApiHandlerParams } from '@/lib/api/handler';
import yaml from 'js-yaml';

export const dynamic = 'force-dynamic';

const Body = z.object({
  action: z.enum(['start', 'stop', 'restart']).default('start'),
}).default({ action: 'start' });

const Query = z.object({ node: z.string().optional() });

type Params = { name: string };

export const POST = withApiHandlerParams<z.infer<typeof Body>, z.infer<typeof Query>, Params>(
  { body: Body, query: Query },
  async ({ body, query, params }) => {
    const nameCheck = ServiceName.safeParse(decodeURIComponent(params.name));
    if (!nameCheck.success) {
      return NextResponse.json({ error: 'invalid name' }, { status: 400 });
    }
    const name = nameCheck.data;
    const nodeName = query.node;
    const action = body.action;

    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    let writerClosed = false;

    const write = async (msg: string) => {
      if (writerClosed) return;
      try {
        await writer.write(encoder.encode(msg + '\r\n'));
      } catch {
        // Client aborted — stop attempting to write to a closed stream.
        writerClosed = true;
      }
    };

    const writeRaw = async (msg: string) => {
      if (writerClosed) return;
      try {
        await writer.write(encoder.encode(msg));
      } catch {
        writerClosed = true;
      }
    };

    (async () => {
      try {
        let connection;
        if (nodeName) {
            const nodes = await listNodes();
            connection = nodes.find(n => n.Name === nodeName);
        }

        const executor = getExecutor(connection);

        const streamNodeName = nodeName || connection?.Name || 'Local';

        if (action === 'start') {
            const { yamlPath } = await ServiceManager.getServiceFiles(streamNodeName, name);

            if (yamlPath) {
              await write(`Found YAML configuration: ${yamlPath}`);
              const content = await executor.readFile(yamlPath);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const parsed = yaml.load(content) as any;

              const images = new Set<string>();
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const findImages = (obj: any) => {
                  if (!obj) return;
                  if (obj.image && typeof obj.image === 'string') images.add(obj.image);
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  if (Array.isArray(obj.containers)) obj.containers.forEach((c: any) => findImages(c));
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  if (Array.isArray(obj.initContainers)) obj.initContainers.forEach((c: any) => findImages(c));
                  if (obj.spec) findImages(obj.spec);
                  if (obj.template) findImages(obj.template);
              };
              findImages(parsed);

              if (images.size > 0) {
                  await write(`Found ${images.size} images to pull...`);
                  const agent = await agentManager.ensureAgent(streamNodeName);
                  for (const image of images) {
                      await write(`Pulling ${image}...`);
                      try {
                          await agent.pullImage(image, async (evt) => {
                              if (evt.id && evt.status) {
                                  if (evt.total && evt.current !== undefined) {
                                      const currentMB = (evt.current / 1048576).toFixed(1);
                                      const totalMB = (evt.total / 1048576).toFixed(1);
                                      const pct = Math.round(evt.current / evt.total * 100);
                                      await write(`  Layer ${evt.id.slice(0, 12)}: ${evt.status} ${currentMB} MB / ${totalMB} MB (${pct}%)`);
                                  } else {
                                      await write(`  Layer ${evt.id.slice(0, 12)}: ${evt.status}`);
                                  }
                              }
                          });
                          await write(`✓ Successfully pulled ${image}`);
                      } catch (e) {
                          await write(`✗ Failed to pull ${image}: ${e instanceof Error ? e.message : String(e)}`);
                      }
                  }
              } else {
                  await write('No images found in YAML configuration.');
              }
            } else {
                await write('No YAML configuration found. Skipping explicit pull.');
            }

            await write('Starting service...');
            await executor.execArgv(['systemctl', '--user', 'start', `${name}.service`]);
            await write('✓ Service started successfully.');
        } else if (action === 'stop') {
            await write(`Stopping service ${name}...`);
            await executor.execArgv(['systemctl', '--user', 'stop', `${name}.service`]);
            await write('✓ Service stopped.');
        } else if (action === 'restart') {
            await write(`Restarting service ${name}...`);
            await executor.execArgv(['systemctl', '--user', 'restart', `${name}.service`]);
            await write('✓ Service restarted.');
        }

        // Show status output
        await write('\r\n--- Service Status ---\r\n');
        try {
            // Use --no-pager so systemctl status doesn't hang on user input,
            // and -l for full lines. PTY preserves color codes.
            const { stdout, stderr, promise } = executor.spawn(`systemctl --user status ${name}.service --no-pager -l`, { pty: true, cols: 160 });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const streamToWriter = async (stream: any) => {
                for await (const chunk of stream) {
                    await writeRaw(chunk.toString());
                }
            };

            await Promise.all([
                streamToWriter(stdout),
                streamToWriter(stderr),
                promise
            ]);
        } catch {
            // systemctl status exits non-zero on stopped/failed services
            // which makes our spawn() reject; the stream output has
            // already been written, so swallow the error here.
        }

      } catch (e) {
        await write(`Error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (!writerClosed) {
          try { await writer.close(); } catch { /* already closed */ }
        }
      }
    })();

    return new NextResponse(stream.readable, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      },
    });
  },
);
