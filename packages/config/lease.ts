import { mkdir, readFile, writeFile, rm, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
export interface DaemonInfo {
  pid: number;
  uiPort: number;
  mcpPort: number;
  instance: string;
  startedAt: string;
}
export async function readDaemon(directory: string): Promise<DaemonInfo | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'daemon.json'), 'utf8'));
  } catch {
    return undefined;
  }
}
async function identity(pid: number | 'self') {
  const processId = pid === 'self' ? process.pid : pid;
  if (!Number.isInteger(processId) || processId <= 0) return undefined;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${processId} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        { timeout: 5000, windowsHide: true },
      );
      return stdout.trim() ? 'windows:' + stdout.trim() : undefined;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await run(
        '/bin/ps',
        ['-p', String(processId), '-o', 'lstart=', '-o', 'comm='],
        { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } },
      );
      return stdout.trim() ? 'macos:' + stdout.trim() : undefined;
    }
    if (process.platform !== 'linux') return undefined;
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    return (
      (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() +
      ':' +
      text.slice(text.lastIndexOf(')') + 2).split(' ')[19]
    );
  } catch {
    return undefined;
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
export async function acquireLease(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'daemon.lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(
        join(path, 'owner.json'),
        JSON.stringify({ pid: process.pid, identity: await identity('self') }),
        { mode: 0o600 },
      );
      return async () => {
        await rm(path, { recursive: true, force: true });
        await rm(join(directory, 'daemon.json'), { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let owner: { pid: number; identity?: string } | undefined;
      try {
        owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
        if (!Number.isInteger(owner?.pid) || !owner || owner.pid <= 0) owner = undefined;
      } catch {}
      const observed = owner?.identity ? await identity(owner.pid) : undefined;
      if (
        owner &&
        alive(owner.pid) &&
        (!owner.identity || !observed || owner.identity === observed)
      )
        throw new Error('MCP Code is already running or starting.');
      if (!owner && Date.now() - (await stat(path)).mtimeMs < 10_000)
        throw new Error('MCP Code is starting. Try again shortly.');
      // Atomic rename claims a stale lock; a second recovering process cannot delete our new lock.
      const stale = `${path}.stale-${randomUUID()}`;
      try {
        await rename(path, stale);
        await rm(stale, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  throw new Error('Could not acquire runtime lease.');
}
