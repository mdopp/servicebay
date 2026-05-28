#!/usr/bin/env node
/**
 * Entry for the lifecycle launcher TUI (#1231). Renders the Ink menu, and once
 * the operator picks a bash-leg action, unmounts Ink and hands the terminal to
 * that script (ISO build or install-watch) with inherited stdio.
 *
 * Run: `npm run tui`
 */
import { render } from 'ink';
import { spawn } from 'node:child_process';
import { App } from './App.js';
import { makeProbes } from './probes.js';
import { isoBuildCommand, installWatchCommand, type Command } from './actions.js';

function runInteractive(command: Command): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command.cmd, command.args, { stdio: 'inherit' });
    child.on('exit', code => resolve(code ?? 0));
    child.on('error', () => resolve(1));
  });
}

async function main(): Promise<void> {
  const choice: { value: 'build-iso' | 'watch-install' | null } = { value: null };
  const app = render(
    <App
      probes={makeProbes()}
      onChoose={action => {
        choice.value = action;
      }}
    />,
  );
  await app.waitUntilExit();

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
