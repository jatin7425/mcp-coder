import { AppError } from '../shared/types.js';
import type { TunnelProvider } from './provider.js';
import { CloudflareProvider } from './cloudflare.js';
import { NgrokProvider } from './ngrok.js';
export class TunnelManager {
  private providers = new Map<string, TunnelProvider>();
  private active?: TunnelProvider;
  private starting = false;
  private generation = 0;
  constructor() {
    this.register(new CloudflareProvider());
    this.register(new NgrokProvider());
  }
  register(provider: TunnelProvider) {
    if (this.providers.has(provider.id)) throw new Error('Duplicate tunnel provider.');
    this.providers.set(provider.id, provider);
  }
  async availability() {
    return Promise.all(
      [...this.providers.values()].map(async (p) => ({
        id: p.id,
        name: p.name,
        available: await p.checkAvailability(),
      })),
    );
  }
  status() {
    return this.active?.status() || { state: 'stopped' as const };
  }
  async start(id: string, localPort: number) {
    if (
      this.starting ||
      (this.active && ['connected', 'starting'].includes(this.active.status().state))
    )
      throw new AppError('Stop the existing tunnel first.', 409);
    const provider = this.providers.get(id);
    if (!provider) throw new AppError('Unknown tunnel provider.');
    this.active = provider;
    this.starting = true;
    const generation = ++this.generation;
    try {
      const result = await provider.start(localPort);
      if (generation !== this.generation) {
        await provider.stop();
        throw new AppError('Tunnel start cancelled.', 409);
      }
      return result;
    } finally {
      this.starting = false;
    }
  }
  async stop() {
    this.generation++;
    const provider = this.active;
    this.active = undefined;
    await provider?.stop();
  }
}
