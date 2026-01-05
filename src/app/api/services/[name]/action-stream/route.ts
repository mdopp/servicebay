
import { NextResponse } from 'next/server';
import { getExecutor } from '@/lib/executor';
import { listNodes } from '@/lib/nodes';
import { getServiceFiles } from '@/lib/manager';
import yaml from 'js-yaml';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  
  // Parse body for action
  let action = 'start';
  try {
      const body = await request.json();
      if (body.action) action = body.action;
  } catch (e) {
      // Ignore if body is empty/invalid, default to start (backward compatibility if needed)
  }

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const write = async (msg: string) => {
    await writer.write(encoder.encode(msg + '\r\n'));
  };

  const writeRaw = async (msg: string) => {
    await writer.write(encoder.encode(msg));
  };

  (async () => {
    try {
      let connection;
      if (nodeName) {
          const nodes = await listNodes();
          connection = nodes.find(n => n.Name === nodeName);
      }
      
      const executor = getExecutor(connection);

      if (action === 'start') {
          const { yamlPath } = await getServiceFiles(name, connection);

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
                for (const image of images) {
                    await write(`Pulling ${image}...`);
                    try {
                        const { stdout, stderr, promise } = executor.spawn(`podman pull ${image}`, { pty: true, cols: 120 });
                        
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
                        
                        await write(`\r\n✓ Successfully pulled ${image}`);
                    } catch (e) {
                        await write(`\r\n✗ Failed to pull ${image}: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            } else {
                await write('No images found in YAML configuration.');
            }
          } else {
              await write('No YAML configuration found. Skipping explicit pull.');
          }

          await write('Starting service...');
          await executor.exec(`systemctl --user start ${name}.service`);
          await write('✓ Service started successfully.');
      } else if (action === 'stop') {
          await write(`Stopping service ${name}...`);
          await executor.exec(`systemctl --user stop ${name}.service`);
          await write('✓ Service stopped.');
      } else if (action === 'restart') {
          await write(`Restarting service ${name}...`);
          await executor.exec(`systemctl --user restart ${name}.service`);
          await write('✓ Service restarted.');
      }

      // Show status output
      await write('\r\n--- Service Status ---\r\n');
      try {
          // We use spawn to stream the status output, although it's usually short.
          // But it preserves colors if we use PTY (systemctl status has colors).
          // Use --no-pager to avoid hanging on user input, and -l to show full lines.
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
      } catch (_e) {
          // systemctl status returns non-zero if service is stopped/failed, which causes spawn promise to reject.
          // We still want to show the output.
          // Our spawn implementation rejects on non-zero exit code.
          // But we might have already streamed the output.
          // So we can just ignore the error here, as the output is what matters.
          // Or we can catch it and print a message if needed.
          // Actually, our spawn implementation in executor.ts rejects AFTER streaming.
          // So the output should be visible.
      }

    } catch (e) {
      await write(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await writer.close();
    }
  })();

  return new NextResponse(stream.readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
    },
  });
}
