import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { platformConfigDirectory } from '../shared/platform.js';
import type { AppState } from '../shared/types.js';
export function configDirectory() {
  return platformConfigDirectory(process.platform, homedir(), process.env);
}
export interface ConfigStore {
  state: AppState;
  save(): Promise<void>;
}
export interface CredentialStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
// No plaintext fallback. Native tunnel adapters own their authentication until an OS keychain adapter is configured.
export class NativeCredentialStore implements CredentialStore {
  async get(_key: string): Promise<string | undefined> {
    return undefined;
  }
  async set(_key: string, _value: string): Promise<void> {
    throw new Error(
      'Use the provider native authentication; no application credential store is configured.',
    );
  }
  async delete(_key: string): Promise<void> {}
}
export class JsonStore implements ConfigStore {
  state!: AppState;
  private queue = Promise.resolve();
  constructor(public directory: string) {}
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      this.state = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
      if (
        this.state.schemaVersion !== 1 ||
        !Array.isArray(this.state.workspaces) ||
        !Array.isArray(this.state.tokens) ||
        !Array.isArray(this.state.audit)
      )
        throw new Error('Invalid state schema');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'Cannot read configuration. Restore or repair state.json; it has not been overwritten.',
        );
      this.state = {
        schemaVersion: 1,
        workspaces: [],
        tokens: [],
        audit: [],
        settings: { uiPort: 7865, mcpPort: 7866, retentionDays: 7 },
      };
      await this.save();
    }
    return this;
  }
  save() {
    const data = JSON.stringify(this.state, null, 2);
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        const temp = join(this.directory, 'state.json.tmp');
        await writeFile(temp, data, { mode: 0o600 });
        await chmod(temp, 0o600);
        await rename(temp, join(this.directory, 'state.json'));
      });
    return this.queue;
  }
}
