#!/usr/bin/env node

/**
 * nextgenchat CLI bootstrapper
 *
 * Small npm-published bootstrap entrypoint that downloads and runs the canonical
 * GitHub installer so the npm and GitHub one-liners stay on the same install path.
 */

import { spawn } from 'node:child_process';

const DEFAULT_INSTALL_SCRIPT_URLS = {
  windows: 'https://raw.githubusercontent.com/AmmarAlasad/NextGenChat/main/scripts/install.ps1',
  unix: 'https://raw.githubusercontent.com/AmmarAlasad/NextGenChat/main/scripts/install.sh',
};

function printHelp() {
  process.stdout.write(`NextGenChat installer CLI

Usage:
  nextgenchat install
  npx nextgenchat@latest install

Environment overrides:
  NEXTGENCHAT_INSTALL_SCRIPT_URL   Override the installer URL
  NEXTGENCHAT_REPO_URL             Override the git clone URL used by the installer
  NEXTGENCHAT_DIR                  Install/update target directory
  NEXTGENCHAT_HOME                 Runtime data root (defaults to ~/.nextgenchat)
`);
}

async function runInstall() {
  const installScriptUrl = process.env.NEXTGENCHAT_INSTALL_SCRIPT_URL
    || (process.platform === 'win32' ? DEFAULT_INSTALL_SCRIPT_URLS.windows : DEFAULT_INSTALL_SCRIPT_URLS.unix);
  const response = await fetch(installScriptUrl);

  if (!response.ok) {
    throw new Error(`Failed to download installer: ${response.status} ${response.statusText}`);
  }

  const script = await response.text();
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
        stdio: ['pipe', 'inherit', 'inherit'],
        env: process.env,
      })
    : spawn('bash', ['-s'], {
        stdio: ['pipe', 'inherit', 'inherit'],
        env: process.env,
      });

  child.stdin.write(script);
  child.stdin.end();

  await new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }

      reject(new Error(`Installer exited with code ${code ?? 'unknown'}`));
    });
    child.on('error', reject);
  });
}

const command = process.argv[2] ?? 'help';

if (command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

if (command === 'install') {
  runInstall().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Installer failed'}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write(`Unknown command: ${command}\n\n`);
  printHelp();
  process.exit(1);
}
