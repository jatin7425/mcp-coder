import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../shared/types.js';
import type { TunnelProvider, TunnelStatus } from './provider.js';
const exec = promisify(execFile);
export interface NativeTunnelOptions {
  id: string;
  name: string;
  executable: string;
  versionArguments: string[];
  arguments: (port: number) => string[];
  discoverUrl: (output: string) => string | undefined;
  setupMessage: string;
}
export class NativeTunnelProvider implements TunnelProvider {
  readonly id: string;
  readonly name: string;
  constructor(private readonly options: NativeTunnelOptions) {
    this.id = options.id;
    this.name = options.name;
  }
  private child?: ChildProcess;
  private generation = 0;
  private current: TunnelStatus = { state: 'stopped' };
  private pendingReject?: (error: Error) => void;
  status() {
    return { ...this.current };
  }
  async checkAvailability() {
    try {
      await exec(this.options.executable, this.options.versionArguments, {
        timeout: 5000,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }
  async authenticate(_config: unknown) {
    /* Credentials remain in the native CLI configuration. */
  }
  async start(localPort: number): Promise<{ publicUrl: string }> {
    if (this.child || this.current.state === 'starting')
      throw new AppError('Tunnel is already starting or connected.', 409);
    this.current = { state: 'starting', provider: this.id };
    const generation = ++this.generation;
    const available = await this.checkAvailability();
    if (generation !== this.generation) throw new AppError('Tunnel start cancelled.', 409);
    if (!available) {
      this.current = {
        state: 'error',
        provider: this.id,
        error: this.options.setupMessage,
      };
      throw new AppError(this.current.error!, 503);
    }
    return new Promise((resolve, reject) => {
      let buffer = '',
        settled = false;
      const finish = (error?: Error, publicUrl?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingReject = undefined;
        if (error) {
          this.current = { state: 'error', provider: this.id, error: error.message };
          this.child?.kill('SIGTERM');
          reject(error);
        } else {
          this.current = { state: 'connected', provider: this.id, publicUrl };
          resolve({ publicUrl: publicUrl! });
        }
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `${this.name} did not provide an HTTPS URL within 45 seconds. ${this.options.setupMessage}`,
            ),
          ),
        45_000,
      );
      this.pendingReject = (error) => finish(error);
      const child = spawn(this.options.executable, this.options.arguments(localPort), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      const capture = (chunk: Buffer) => {
        buffer = (buffer + chunk.toString()).slice(-8192);
        const url = this.options.discoverUrl(buffer);
        if (url) finish(undefined, url);
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        this.child = undefined;
        if (!settled)
          finish(
            new Error(
              `${this.name} exited (${code}). ${this.options.setupMessage} Check the native CLI configuration and network.`,
            ),
          );
        else if (this.current.state === 'connected')
          this.current = { state: 'error', provider: this.id, error: 'Tunnel process stopped.' };
      });
    });
  }
  async stop() {
    this.generation++;
    const child = this.child;
    this.pendingReject?.(new Error('Tunnel start cancelled.'));
    if (child && child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 3000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    this.child = undefined;
    this.current = { state: 'stopped' };
  }
}
