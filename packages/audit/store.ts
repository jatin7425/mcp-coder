import { randomUUID } from 'node:crypto';
import type { ConfigStore } from '../config/store.js';
import type { AuditEntry } from '../shared/types.js';
export interface AuditStore {
  record(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void>;
  clear(): Promise<void>;
}
export class AuditLogger implements AuditStore {
  constructor(private store: ConfigStore) {}
  async record(entry: Omit<AuditEntry, 'id' | 'timestamp'>) {
    this.store.state.audit.push({
      ...entry,
      command: entry.command?.slice(0, 4096),
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    this.prune();
    await this.store.save();
  }
  prune() {
    const cutoff = Date.now() - this.store.state.settings.retentionDays * 86400_000;
    this.store.state.audit = this.store.state.audit
      .filter((e) => Date.parse(e.timestamp) > cutoff)
      .slice(-1000);
  }
  async clear() {
    this.store.state.audit = [];
    await this.store.save();
  }
}
