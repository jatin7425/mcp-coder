import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AppError } from '../shared/types.js';
import { NativeTunnelProvider } from './native.js';
import type { TunnelConfig } from './config.js';
export function cloudflareArguments(
  port: number,
  config: TunnelConfig,
  configFile?: string,
): string[] {
  if (config.mode === 'cloudflare-named')
    return [
      'tunnel',
      ...(configFile ? ['--config', configFile] : []),
      '--no-autoupdate',
      '--url',
      `http://127.0.0.1:${port}`,
      '--credentials-file',
      config.credentialsFile,
      'run',
      config.tunnelId,
    ];
  return [
    'tunnel',
    ...(configFile ? ['--config', configFile] : []),
    '--no-autoupdate',
    '--url',
    `http://127.0.0.1:${port}`,
  ];
}
export class CloudflareProvider extends NativeTunnelProvider {
  private configuration: { value: TunnelConfig; configFile?: string };
  private directory?: string;
  async start(port: number) {
    if (['starting', 'connected'].includes(this.status().state))
      throw new AppError('Tunnel is already active.', 409);
    this.directory = await mkdtemp(join(tmpdir(), 'mcp-code-cloudflare-'));
    this.configuration.configFile = join(this.directory, 'config.json');
    // An explicit isolated config prevents unrelated native ingress rules from being exposed.
    await writeFile(this.configuration.configFile, '{}', { mode: 0o600 });
    try {
      return await super.start(port);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async stop() {
    await super.stop();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = undefined;
    this.configuration.configFile = undefined;
  }
  configure(config: TunnelConfig) {
    if (config.mode === 'cloudflare-named' && !isAbsolute(config.credentialsFile))
      throw new AppError(
        'Choose an absolute path to the native Cloudflare tunnel credentials file.',
      );
    this.configuration.value = config;
  }
  async diagnostics() {
    if (!(await this.checkAvailability()))
      return { ready: false, detail: 'Install cloudflared, then check again.' };
    const config = this.configuration.value;
    if (config.mode === 'cloudflare-named') {
      try {
        await access(config.credentialsFile);
      } catch {
        return {
          ready: false,
          detail: 'The tunnel credentials file is unavailable. Check the saved absolute path.',
        };
      }
      return {
        ready: true,
        detail:
          'cloudflared and the credentials file are available. Ensure this hostname is routed to the configured tunnel in Cloudflare.',
      };
    }
    return {
      ready: true,
      detail: 'cloudflared is installed. A quick tunnel needs no account credentials.',
    };
  }
  constructor() {
    const configuration: { value: TunnelConfig; configFile?: string } = {
      value: { mode: 'temporary' },
    };
    super({
      id: 'cloudflare',
      name: 'Cloudflare',
      executable: 'cloudflared',
      versionArguments: ['--version'],
      arguments: (port) => cloudflareArguments(port, configuration.value, configuration.configFile),
      discoverUrl: (output) =>
        configuration.value.mode === 'cloudflare-named'
          ? /Registered tunnel connection/.test(output)
            ? configuration.value.publicUrl
            : undefined
          : /Registered tunnel connection/.test(output)
            ? output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0]
            : undefined,
      setupMessage:
        'Install cloudflared. For a named tunnel, verify the tunnel ID, credentials file, and DNS route. Otherwise use a quick tunnel.',
    });
    this.configuration = configuration;
  }
}
