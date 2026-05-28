#!/usr/bin/env node
/**
 * Entry for the lifecycle launcher TUI (#1231). Renders the Ink menu, and once
 * the operator picks an action, hands off: the ISO version-picker (#1238) for
 * choose-iso, or a bash leg (ISO build / install-watch) with inherited stdio.
 *
 * Run: `npm run tui`
 */
import { render } from 'ink';
import { spawn } from 'node:child_process';
import { App } from './App.js';
import { IsoPicker } from './IsoPicker.js';
import { makeProbes } from './probes.js';
import { isoBuildCommand, installWatchCommand, type Command } from './actions.js';
import { buildChoices, downloadCommand, type IsoChoice } from './isoPicker.js';
import { BUILD_DIR, fetchAllStreams, hostArch, listLocalIsos } from './isoProbes.js';

function runInteractive(command: Command): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command.cmd, command.args, { stdio: 'inherit' });
    child.on('exit', code => resolve(code ?? 0));
    child.on('error', () => resolve(1));
  });
}

async function loadIsoChoices(): Promise<{ choices: IsoChoice[]; hostArch: string }> {
  const arch = hostArch();
  const [localIsos, remote] = await Promise.all([listLocalIsos(), fetchAllStreams()]);
  return { choices: buildChoices({ localIsos, remote, hostArch: arch }), hostArch: arch };
}

/** Render the picker and resolve the operator's choice (null on cancel). */
function pickIso(): Promise<IsoChoice | null> {
  return new Promise(resolve => {
    const picker = render(
      <IsoPicker
        loadChoices={loadIsoChoices}
        onSelect={choice => {
          picker.unmount();
          resolve(choice);
        }}
        onCancel={() => {
          picker.unmount();
          resolve(null);
        }}
      />,
    );
  });
}

/** Acquire an ISO: local picks are already on disk; remote picks download via
 *  coreos-installer (native progress on inherited stdio). */
async function handleChooseIso(): Promise<void> {
  const choice = await pickIso();
  if (!choice) return;
  if (choice.kind === 'local') {
    console.log(`Using local ISO: ${choice.path}`);
    return;
  }
  console.log(`Downloading Fedora CoreOS ${choice.stream}/${choice.arch} into ${BUILD_DIR}…`);
  const code = await runInteractive(downloadCommand(choice.stream!, choice.arch!, BUILD_DIR));
  process.exit(code);
}

async function main(): Promise<void> {
  const choice: { value: 'choose-iso' | 'build-iso' | 'watch-install' | null } = { value: null };
  const app = render(
    <App
      probes={makeProbes()}
      onChoose={action => {
        choice.value = action;
      }}
    />,
  );
  await app.waitUntilExit();

  if (choice.value === 'choose-iso') {
    await handleChooseIso();
    return;
  }
  if (choice.value === 'build-iso') {
    process.exit(await runInteractive(isoBuildCommand()));
  }
  if (choice.value === 'watch-install') {
    process.exit(await runInteractive(installWatchCommand()));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
