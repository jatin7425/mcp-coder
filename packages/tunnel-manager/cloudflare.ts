import { NativeTunnelProvider } from './native.js';
export class CloudflareProvider extends NativeTunnelProvider {
  constructor() {
    super({
      id: 'cloudflare',
      name: 'Cloudflare quick tunnel',
      executable: 'cloudflared',
      versionArguments: ['--version'],
      arguments: (port) => ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
      discoverUrl: (output) => output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0],
      setupMessage: 'Install cloudflared on this computer before starting a tunnel.',
    });
  }
}
