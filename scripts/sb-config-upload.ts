#!/usr/bin/env node
/**
 * `sb-config-upload` CLI (#1219): seed the FritzBox NAS with a service's config
 * from a non-ServiceBay source. Thin argv + readline shell around the testable
 * core in packages/backend/src/lib/externalBackup/configUpload.ts.
 *
 * Run: `npm run sb-config-upload -- --service adguard --from /path/to/config`
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  parseUploadArgs,
  runConfigUpload,
  ConfigUploadError,
  USAGE,
} from '../packages/backend/src/lib/externalBackup/configUpload.js';

async function main(): Promise<void> {
  const parsed = parseUploadArgs(process.argv.slice(2));
  if ('help' in parsed) {
    console.log(USAGE);
    return;
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    await runConfigUpload(parsed, {
      log: message => console.log(message),
      confirm: async question => {
        const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
      },
    });
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigUploadError) {
    console.error(`error: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
