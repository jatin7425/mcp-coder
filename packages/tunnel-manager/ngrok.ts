import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TunnelConfig } from './config.js';
import { NativeTunnelProvider } from './native.js';

/** Accept only the URL from a completed endpoint-start event, never arbitrary log URLs. */
export function ngrokPublicUrl(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.msg !== 'started tunnel' || typeof event.url !== 'string') continue;
      const url = new URL(event.url);
      if (
        url.protocol !== 'https:' ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        continue;
      return url.origin;
    } catch {
      /* Wait for a complete JSON log line. */
    }
  }
}

export function ngrokArguments(port: number, publicUrl?: string): string[] {
  return [
    'http',
    `http://127.0.0.1:${port}`,
    '--log=stdout',
    '--log-format=json',
    '--log-level=info',
    '--inspect=false',
    ...(publicUrl ? ['--url', publicUrl] : []),
  ];
}

export class NgrokProvider extends NativeTunnelProvider {
  private configuration: { publicUrl?: string };
  configure(config: TunnelConfig) {
    this.configuration.publicUrl = config.mode === 'ngrok-domain' ? config.publicUrl : undefined;
  }
  async diagnostics() {
    if (!(await this.checkAvailability()))
      return { ready: false, detail: 'Install ngrok, then check again.' };
    try {
      await promisify(execFile)('ngrok', ['config', 'check'], { timeout: 5000, windowsHide: true });
      return {
        ready: true,
        detail:
          'ngrok is installed and its configuration is valid. Account authentication and domain access are checked when connecting.',
      };
    } catch {
      return {
        ready: false,
        detail:
          'Configure ngrok with ngrok config add-authtoken YOUR_TOKEN, then run ngrok config check. Credentials stay with ngrok.',
      };
    }
  }
  constructor() {
    const configuration: { publicUrl?: string } = {};
    super({
      id: 'ngrok',
      name: 'ngrok',
      executable: 'ngrok',
      versionArguments: ['version'],
      arguments: (port) => ngrokArguments(port, configuration.publicUrl),
      discoverUrl: (output) => {
        const discovered = ngrokPublicUrl(output);
        return !configuration.publicUrl || discovered === configuration.publicUrl
          ? discovered
          : undefined;
      },
      setupMessage:
        'Install ngrok and configure its native CLI with ngrok config add-authtoken before starting a tunnel.',
    });
    this.configuration = configuration;
  }
}
