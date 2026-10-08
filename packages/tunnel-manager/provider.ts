import type { TunnelConfig } from './config.js';
export interface TunnelStatus {
  state: 'stopped' | 'starting' | 'connected' | 'error';
  provider?: string;
  publicUrl?: string;
  error?: string;
}
export interface TunnelProvider {
  id: string;
  name: string;
  checkAvailability(): Promise<boolean>;
  configure?(config: TunnelConfig): void;
  diagnostics?(): Promise<{ ready: boolean; detail: string }>;
  authenticate(config: unknown): Promise<void>;
  start(localPort: number): Promise<{ publicUrl: string }>;
  stop(): Promise<void>;
  status(): TunnelStatus;
}
