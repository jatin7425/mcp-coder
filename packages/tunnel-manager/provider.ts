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
  authenticate(config: unknown): Promise<void>;
  start(localPort: number): Promise<{ publicUrl: string }>;
  stop(): Promise<void>;
  status(): TunnelStatus;
}
