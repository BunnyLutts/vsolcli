import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function cliLaunch(configured: string): { executable: string; prefix: string[]; environment: NodeJS.ProcessEnv } {
  if (!configured.trim()) return { executable: process.execPath, prefix: [require.resolve('@aloth/olcli/cli')], environment: { ELECTRON_RUN_AS_NODE: '1' } };
  return { executable: resolveExecutable(configured.trim()), prefix: [], environment: {} };
}

export function resolveExecutable(configured: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path.isAbsolute(configured) || configured.includes('/') || configured.includes('\\')) return configured;
  const home = os.homedir();
  const directories = [
    ...(env.PATH ?? env.Path ?? '').split(path.delimiter),
    env.PNPM_HOME,
    path.join(home, '.local', 'share', 'pnpm', 'bin'),
    path.join(home, '.local', 'share', 'pnpm'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    env.APPDATA && path.join(env.APPDATA, 'npm'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'pnpm'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'
  ];
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = path.join(directory, configured);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return configured;
}
