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

export function ngrokArguments(port: number): string[] {
  return [
    'http',
    `http://127.0.0.1:${port}`,
    '--log=stdout',
    '--log-format=json',
    '--log-level=info',
    '--inspect=false',
  ];
}

export class NgrokProvider extends NativeTunnelProvider {
  constructor() {
    super({
      id: 'ngrok',
      name: 'ngrok',
      executable: 'ngrok',
      versionArguments: ['version'],
      arguments: ngrokArguments,
      discoverUrl: ngrokPublicUrl,
      setupMessage:
        'Install ngrok and configure its native CLI with ngrok config add-authtoken before starting a tunnel.',
    });
  }
}
