#!/usr/bin/env node

const { existsSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_INSTALL_SCRIPT_URLS = {
  windows: 'https://raw.githubusercontent.com/AmmarAlasad/NextGenChat/main/scripts/install.ps1',
  macos: 'https://raw.githubusercontent.com/AmmarAlasad/NextGenChat/main/scripts/install-macos.sh',
  unix: 'https://raw.githubusercontent.com/AmmarAlasad/NextGenChat/main/scripts/install.sh',
};

const isWindows = process.platform === 'win32';
const isMacos = process.platform === 'darwin';
const binDir = __dirname;
const packagedRepoDir = resolve(binDir, '..');

function defaultRepoDir() {
  if (process.env.NEXTGENCHAT_DIR) return process.env.NEXTGENCHAT_DIR;
  return isWindows
    ? join(process.env.USERPROFILE || process.cwd(), 'NextGenChat')
    : join(process.env.HOME || process.cwd(), 'NextGenChat');
}

function repoDir() {
  if (existsSync(join(packagedRepoDir, 'scripts'))) return packagedRepoDir;
  return defaultRepoDir();
}

function runtimeDir() {
  if (process.env.NEXTGENCHAT_HOME) return process.env.NEXTGENCHAT_HOME;
  if (isWindows) {
    return join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local'), 'NextGenChat');
  }
  return join(process.env.HOME || process.cwd(), '.nextgenchat');
}

function printHelp() {
  process.stdout.write(`NextGenChat command line

Usage:
  nextgenchat <command> [options]
  ngc <command> [options]

Commands:
  install                  Install or update NextGenChat
  start                    Start the background service
  stop                     Stop the running app; keep automatic startup enabled
  disable                  Stop the app and disable automatic startup
  uninstall, remove        Stop the app and remove the background service
  status                   Show service status
  logs                     Follow service logs
  open                     Open http://localhost:3000
  help                     Show this help

Short flags:
  --install                Same as install
  --start                  Same as start
  --stop                   Same as stop
  --disable                Same as disable
  --uninstall, --remove    Same as uninstall
  --status                 Same as status
  --logs                   Same as logs
  --open                   Same as open
  --help, -h               Show this help

Uninstall data options:
  --keep-data              Keep local conversations, database, logs, and workspaces
  --remove-data            Delete local conversations, database, logs, and workspaces

Install location:
  ${repoDir()}

Local data:
  ${runtimeDir()}

Environment overrides:
  NEXTGENCHAT_INSTALL_SCRIPT_URL   Override the installer URL
  NEXTGENCHAT_REPO_URL             Override the git clone URL used by the installer
  NEXTGENCHAT_DIR                  Install/update target directory
  NEXTGENCHAT_HOME                 Runtime data root
`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio || 'inherit',
      env: process.env,
      cwd: options.cwd || process.cwd(),
      shell: false,
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });
    child.on('error', reject);
  });
}

async function runInstall() {
  const installScriptUrl = process.env.NEXTGENCHAT_INSTALL_SCRIPT_URL
    || (isWindows
      ? DEFAULT_INSTALL_SCRIPT_URLS.windows
      : isMacos
        ? DEFAULT_INSTALL_SCRIPT_URLS.macos
        : DEFAULT_INSTALL_SCRIPT_URLS.unix);
  const response = await fetch(installScriptUrl);

  if (!response.ok) {
    throw new Error(`Failed to download installer: ${response.status} ${response.statusText}`);
  }

  const script = await response.text();
  const child = isWindows
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

function ensureInstalledRepo() {
  const dir = repoDir();
  if (!existsSync(join(dir, 'scripts'))) {
    throw new Error(`NextGenChat is not installed at ${dir}. Run: nextgenchat install`);
  }
  return dir;
}

async function runWindowsService(command, options) {
  const dir = ensureInstalledRepo();
  const script = join(dir, 'scripts', 'service-disable.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, command];
  if (options.removeData) args.push('-RemoveData');
  if (options.keepData) args.push('-KeepData');
  await run('powershell.exe', args);
}

async function runUnixService(command, options) {
  const dir = ensureInstalledRepo();
  const script = isMacos
    ? join(dir, 'scripts', 'service-disable-macos.sh')
    : join(dir, 'scripts', 'service-disable.sh');
  const args = [script, command];
  if (options.removeData) args.push('--remove-data');
  if (options.keepData) args.push('--keep-data');
  await run('bash', args);
}

async function startService() {
  if (isWindows) {
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'Start-ScheduledTask -TaskName NextGenChat']);
    return;
  }
  if (isMacos) {
    const dir = ensureInstalledRepo();
    await run('bash', [join(dir, 'scripts', 'service-install-macos.sh'), 'start']);
    return;
  }
  await run('systemctl', ['--user', 'start', 'nextgenchat.service']);
}

async function statusService() {
  if (isWindows) {
    await run('schtasks.exe', ['/Query', '/TN', 'NextGenChat', '/V', '/FO', 'LIST']);
    return;
  }
  if (isMacos) {
    await run('launchctl', ['print', `gui/${process.getuid()}/com.nextgenchat.local`]);
    return;
  }
  await run('systemctl', ['--user', 'status', 'nextgenchat.service']);
}

async function logsService() {
  if (isWindows) {
    const logs = runtimeDir();
    process.stdout.write(`NextGenChat logs are in:\n  ${join(logs, 'logs')}\n\n`);
    await run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Get-ChildItem -LiteralPath '${join(logs, 'logs').replaceAll("'", "''")}' -Filter '*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 6 | Format-Table LastWriteTime,Name,Length -AutoSize`,
    ]);
    return;
  }
  if (isMacos) {
    const logs = join(process.env.HOME || process.cwd(), 'Library', 'Logs', 'NextGenChat');
    mkdirSync(logs, { recursive: true });
    await run('touch', [join(logs, 'service.out.log'), join(logs, 'service.err.log')]);
    process.stdout.write(`NextGenChat logs are in:\n  ${logs}\n\n`);
    await run('tail', ['-f', join(logs, 'service.out.log'), join(logs, 'service.err.log')]);
    return;
  }
  await run('journalctl', ['--user', '-u', 'nextgenchat.service', '-f']);
}

async function openApp() {
  const url = 'http://localhost:3000';
  if (isWindows) {
    await run('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`]);
    return;
  }
  if (process.platform === 'darwin') {
    await run('open', [url]);
    return;
  }
  await run('xdg-open', [url]);
}

function parseArgs(argv) {
  const options = {
    removeData: argv.includes('--remove-data') || argv.includes('--delete-data'),
    keepData: argv.includes('--keep-data'),
  };
  const optionOnlyFlags = new Set(['--remove-data', '--delete-data', '--keep-data']);
  const command = argv.find((arg) => !arg.startsWith('-'))
    || argv.find((arg) => arg.startsWith('--') && !optionOnlyFlags.has(arg))
    || 'help';
  const normalized = {
    '--help': 'help',
    '-h': 'help',
    'help': 'help',
    '--install': 'install',
    'install': 'install',
    '--start': 'start',
    'start': 'start',
    '--stop': 'stop',
    'stop': 'stop',
    '--disable': 'disable',
    'disable': 'disable',
    '--uninstall': 'uninstall',
    '--remove': 'uninstall',
    'uninstall': 'uninstall',
    'remove': 'uninstall',
    '--status': 'status',
    'status': 'status',
    '--logs': 'logs',
    'logs': 'logs',
    '--open': 'open',
    'open': 'open',
  }[command];

  return { command: normalized || command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === 'help') {
    printHelp();
    return;
  }

  if (command === 'install') {
    await runInstall();
    return;
  }

  if (command === 'start') {
    await startService();
    return;
  }

  if (command === 'stop' || command === 'disable' || command === 'uninstall') {
    const serviceCommand = command === 'uninstall' ? 'remove' : command;
    if (isWindows) {
      await runWindowsService(serviceCommand, options);
    } else {
      await runUnixService(serviceCommand, options);
    }
    return;
  }

  if (command === 'status') {
    await statusService();
    return;
  }

  if (command === 'logs') {
    await logsService();
    return;
  }

  if (command === 'open') {
    await openApp();
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n`);
  printHelp();
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Command failed'}\n`);
  process.exit(1);
});
