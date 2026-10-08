import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxExecution, SandboxProvider } from './provider.js';
import { AppError, type CommandResult } from '../shared/types.js';
import { sandboxIdentity, dockerMountSource } from '../shared/platform.js';
import { validateWorkspace } from '../workspace/manager.js';
const exec = promisify(execFile);
export const SANDBOX_IMAGE = 'mcp-code-sandbox:0.1';
export const OUTPUT_LIMIT = 256 * 1024;
export function normalizeCwd(cwd: string) {
  if (cwd.includes('\0') || cwd.includes('\\')) throw new AppError('Invalid working directory.');
  const normalized = posix.resolve('/workspace', cwd);
  if (normalized !== '/workspace' && !normalized.startsWith('/workspace/'))
    throw new AppError('Working directory must be inside /workspace.');
  return normalized;
}
export function dockerArguments(
  execution: SandboxExecution,
  label: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const { workspace, permissions, input, id } = execution;
  const { uid, gid } = sandboxIdentity(platform);
  return [
    'run',
    '--rm',
    '--pull=never',
    '--name',
    `mcp-code-${id}`,
    '--label',
    `mcp-code.installation=${label}`,
    '--init',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--read-only',
    '--memory=512m',
    '--memory-swap=512m',
    '--cpus=1',
    '--pids-limit=128',
    '--network',
    permissions.network ? 'bridge' : 'none',
    '--user',
    `${uid}:${gid}`,
    '--tmpfs',
    `/tmp:rw,nosuid,nodev,size=256m,mode=1777`,
    '--tmpfs',
    `/home/agent:rw,nosuid,nodev,size=64m,uid=${uid},gid=${gid}`,
    '--mount',
    `type=bind,src=${dockerMountSource(workspace.path, platform)},dst=/workspace${permissions.write ? '' : ',readonly'}`,
    '--workdir',
    normalizeCwd(input.cwd),
    '--env',
    'HOME=/home/agent',
    '--env',
    'npm_config_cache=/tmp/npm-cache',
    '--env',
    'PYTHONDONTWRITEBYTECODE=1',
    '--env',
    'PIP_BREAK_SYSTEM_PACKAGES=1',
    '--env',
    'GIT_CONFIG_COUNT=1',
    '--env',
    'GIT_CONFIG_KEY_0=safe.directory',
    '--env',
    'GIT_CONFIG_VALUE_0=/workspace',
    SANDBOX_IMAGE,
    '/bin/sh',
    '-c',
    input.command,
  ];
}
export class DockerSandbox implements SandboxProvider {
  readonly id = 'docker';
  readonly label: string;
  private active = new Map<string, () => Promise<void>>();
  private build?: ReturnType<typeof spawn>;
  private building = false;
  buildLog = '';
  constructor(private configDir: string) {
    this.label = createHash('sha256').update(resolve(configDir)).digest('hex').slice(0, 20);
  }
  async availability() {
    try {
      const { stdout: engine } = await exec('docker', ['info', '--format', '{{.OSType}}'], {
        timeout: 5000,
        maxBuffer: 65536,
      });
      if (engine.trim() !== 'linux')
        return {
          available: false,
          imageReady: false,
          detail:
            'MCP Code requires Linux containers. Switch Docker Desktop to Linux containers, then refresh.',
        };
      try {
        await exec('docker', ['image', 'inspect', SANDBOX_IMAGE], {
          timeout: 5000,
          maxBuffer: 65536,
        });
        return {
          available: true,
          imageReady: true,
          detail: 'Docker and development image are ready.',
        };
      } catch {
        return {
          available: true,
          imageReady: false,
          detail: 'Build the development image before running commands.',
        };
      }
    } catch {
      return {
        available: false,
        imageReady: false,
        detail: 'Docker is unavailable. Install and start Docker, then refresh.',
      };
    }
  }
  get buildStatus() {
    return { running: this.building, log: this.buildLog };
  }
  startBuild() {
    if (this.building) throw new AppError('Image build is already running.', 409);
    // The packaged Dockerfile is trusted application code, never supplied by an MCP client.
    const sourceRoot = fileURLToPath(
      new URL(
        import.meta.url.includes('/dist/packages/') ? '../../../' : '../../',
        import.meta.url,
      ),
    );
    this.building = true;
    this.buildLog = '';
    this.build = spawn('docker', ['build', '-f', 'Dockerfile.sandbox', '-t', SANDBOX_IMAGE, '.'], {
      cwd: sourceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const append = (chunk: Buffer) => {
      this.buildLog = (this.buildLog + chunk.toString()).slice(-32_768);
    };
    this.build.stdout?.on('data', append);
    this.build.stderr?.on('data', append);
    this.build.on('error', (error) => {
      this.buildLog += error.message;
      this.building = false;
    });
    this.build.on('close', (code) => {
      this.buildLog += `\nBuild exited with ${code}.`;
      this.building = false;
      this.build = undefined;
    });
  }
  async recover() {
    try {
      const { stdout } = await exec(
        'docker',
        ['ps', '-aq', '--filter', `label=mcp-code.installation=${this.label}`],
        { timeout: 5000 },
      );
      const ids = stdout.trim().split(/\s+/).filter(Boolean);
      if (ids.length) await exec('docker', ['rm', '-f', ...ids], { timeout: 15000 });
    } catch (error) {
      // Unavailable Docker is shown in the dashboard; never substitute a host shell.
      if ((await this.availability()).available) throw error;
    }
  }
  async execute(execution: SandboxExecution): Promise<CommandResult> {
    if (execution.signal.aborted) throw new AppError('Command was cancelled.', 409);
    await validateWorkspace(execution.workspace.path, this.configDir);
    const ready = await this.availability();
    if (!ready.available || !ready.imageReady) throw new AppError(ready.detail, 503);
    if (execution.signal.aborted) throw new AppError('Command was cancelled.', 409);
    const args = dockerArguments(execution, this.label);
    const name = `mcp-code-${execution.id}`;
    const started = Date.now();
    return new Promise((resolveResult, reject) => {
      let stdout = '',
        stderr = '',
        bytes = 0,
        truncated = false,
        timedOut = false,
        cancelled = false,
        settled = false;
      let child: ReturnType<typeof spawn> | undefined;
      // Create first, then start. Cancellation waits for creation, so no late-running
      // container can survive a killed docker-run client. No AI code runs during create.
      const creation = exec('docker', ['create', ...args.slice(1)], {
        timeout: 15_000,
        maxBuffer: 65_536,
      });
      const destroy = async () => {
        try {
          await exec('docker', ['rm', '-f', name], { timeout: 10_000 });
        } catch {}
      };
      const stop = async () => {
        cancelled = !timedOut;
        await creation.catch(() => {});
        await destroy();
        child?.kill('SIGTERM');
      };
      this.active.set(execution.id, stop);
      const onAbort = () => {
        void stop();
      };
      execution.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        void stop();
      }, execution.input.timeout);
      const capture = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        const remaining = Math.max(0, OUTPUT_LIMIT - bytes);
        const part = chunk.subarray(0, remaining).toString();
        bytes += Math.min(chunk.length, remaining);
        if (stream === 'stdout') stdout += part;
        else stderr += part;
        if (chunk.length > remaining) truncated = true;
      };
      const finish = async (code: number | null, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        execution.signal.removeEventListener('abort', onAbort);
        await destroy();
        this.active.delete(execution.id);
        if (error) reject(new AppError(`Could not start Docker: ${error.message}`, 503));
        else
          resolveResult({
            exitCode: timedOut ? 124 : cancelled ? 130 : (code ?? 1),
            stdout,
            stderr,
            duration: Date.now() - started,
            truncated,
            timedOut,
            cancelled,
          });
      };
      void creation.then(
        () => {
          if (cancelled || timedOut || execution.signal.aborted) {
            void finish(130);
            return;
          }
          child = spawn('docker', ['start', '--attach', name], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          child.stdout?.on('data', (chunk) => capture(chunk, 'stdout'));
          child.stderr?.on('data', (chunk) => capture(chunk, 'stderr'));
          child.once('error', (error) => {
            void finish(null, error);
          });
          child.once('close', (code) => {
            void finish(code);
          });
        },
        (error) => {
          void finish(null, error);
        },
      );
      if (execution.signal.aborted) void stop();
    });
  }
  async stopAll() {
    this.build?.kill('SIGTERM');
    await Promise.all([...this.active.values()].map((stop) => stop()));
    await this.recover();
  }
}
