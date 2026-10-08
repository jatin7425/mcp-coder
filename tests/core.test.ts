import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../packages/config/store.js';
import { acquireLease } from '../packages/config/lease.js';
import { TokenManager } from '../packages/authentication/tokens.js';
import { WorkspaceManager, validateWorkspace } from '../packages/workspace/manager.js';
import { requireTerminal, intersect } from '../packages/permissions/policy.js';
import { defaultPermissions } from '../packages/shared/types.js';
import { dockerArguments, normalizeCwd } from '../packages/sandbox/docker.js';
import { localHostAllowed, localOriginAllowed } from '../packages/daemon/runtime.js';
import { TunnelManager } from '../packages/tunnel-manager/manager.js';
import { NativeTunnelProvider } from '../packages/tunnel-manager/native.js';
import { ngrokPublicUrl, ngrokArguments } from '../packages/tunnel-manager/ngrok.js';
import type { TunnelProvider, TunnelStatus } from '../packages/tunnel-manager/provider.js';
async function fixture(t: TestContext) {
  const dir = await mkdtemp(
    join(process.platform === 'win32' ? homedir() : tmpdir(), 'mcp-code-core-'),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config');
  const store = await new JsonStore(config).load();
  const path = join(dir, 'project');
  await mkdir(path);
  const workspaces = new WorkspaceManager(store, config);
  const workspace = await workspaces.add(path);
  return { dir, config, store, workspace, workspaces, tokens: new TokenManager(store) };
}
test('atomic local storage persists with private permissions and refuses damaged state', async (t) => {
  const f = await fixture(t);
  if (process.platform !== 'win32')
    assert.equal((await stat(join(f.config, 'state.json'))).mode & 0o777, 0o600);
  assert.equal((await new JsonStore(f.config).load()).state.workspaces.length, 1);
  await writeFile(join(f.config, 'state.json'), 'bad json');
  await assert.rejects(new JsonStore(f.config).load(), /not been overwritten/);
  assert.equal(await readFile(join(f.config, 'state.json'), 'utf8'), 'bad json');
});
test('tokens are hashed, scoped, expired, revoked and rotated without plaintext persistence', async (t) => {
  const f = await fixture(t);
  const first = await f.tokens.create('Client', f.workspace.id, defaultPermissions, 24);
  assert.match(first.token, /^mcpc_/);
  assert.equal(f.tokens.verify(first.token).workspaceId, f.workspace.id);
  assert.ok(!(await readFile(join(f.config, 'state.json'), 'utf8')).includes(first.token));
  assert.throws(() => f.tokens.verify('mcpc_bad'), /Invalid/);
  f.store.state.tokens[0].expiresAt = new Date(0).toISOString();
  assert.throws(() => f.tokens.verify(first.token), /expired/);
  const second = await f.tokens.create('Client', f.workspace.id, defaultPermissions);
  await f.tokens.revoke(second.record.id);
  assert.throws(() => f.tokens.verify(second.token), /revoked/);
  const third = await f.tokens.create('Client', f.workspace.id, defaultPermissions);
  f.store.state.activeWorkspaceId = undefined;
  assert.throws(() => f.tokens.verify(third.token), /not active/);
});
test('workspace validation rejects traversal to sensitive roots and symlink roots/parents', async (t) => {
  const f = await fixture(t);
  await assert.rejects(validateWorkspace('/', f.config));
  await assert.rejects(validateWorkspace(homedir(), f.config));
  await assert.rejects(validateWorkspace(f.config, f.config));
  await assert.rejects(validateWorkspace('/etc', f.config));
  await assert.rejects(validateWorkspace(process.cwd(), f.config), /installation/);
  const link = join(f.dir, 'link');
  await symlink(f.workspace.path, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateWorkspace(link, f.config));
  await mkdir(join(f.workspace.path, 'child'));
  await assert.rejects(validateWorkspace(join(link, 'child'), f.config), /symlinked/);
  assert.equal(
    await validateWorkspace(f.workspace.path, f.config),
    await import('node:fs/promises').then((fs) => fs.realpath(f.workspace.path)),
  );
});
test('effective permissions intersect, and selective shell restrictions fail closed', async (t) => {
  const f = await fixture(t);
  const issued = await f.tokens.create('Client', f.workspace.id, defaultPermissions);
  const principal = f.tokens.verify(issued.token);
  assert.equal(intersect(defaultPermissions, { ...defaultPermissions, write: false }).write, false);
  requireTerminal(f.workspace, principal);
  for (const key of ['read', 'write', 'execute', 'git'] as const)
    assert.throws(
      () =>
        requireTerminal(
          { ...f.workspace, permissions: { ...defaultPermissions, [key]: false } },
          principal,
        ),
      /denied|requires/,
    );
});
test('working directories and Docker arguments enforce the selected mount and network boundary', async (t) => {
  const f = await fixture(t);
  assert.equal(normalizeCwd('src'), '/workspace/src');
  assert.throws(() => normalizeCwd('../../etc'));
  assert.throws(() => normalizeCwd('/etc'));
  const args = dockerArguments(
    {
      id: 'test',
      workspace: f.workspace,
      permissions: defaultPermissions,
      input: { command: 'pwd', timeout: 1000, cwd: '/workspace' },
      signal: new AbortController().signal,
    },
    'test',
  );
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.ok(args.includes('--read-only'));
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args.filter((a) => a.startsWith('type=bind')).length, 1);
  assert.ok(!args.join(' ').includes('docker.sock'));
  assert.ok(!args.includes('--privileged'));
});
test('daemon lease prevents duplicates, releases cleanly, and recovers stale PID', async (t) => {
  const f = await fixture(t);
  const release = await acquireLease(f.config);
  await assert.rejects(acquireLease(f.config), /already running/);
  await release();
  await mkdir(join(f.config, 'daemon.lock'));
  await writeFile(join(f.config, 'daemon.lock', 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  const recovered = await acquireLease(f.config);
  await recovered();
  await mkdir(join(f.config, 'daemon.lock'));
  await writeFile(
    join(f.config, 'daemon.lock', 'owner.json'),
    JSON.stringify({ pid: process.pid, identity: 'old-boot:0' }),
  );
  const reused = await acquireLease(f.config);
  await reused();
});
test('local dashboard rejects malicious Host and Origin', () => {
  assert.ok(localHostAllowed('localhost:7865', 7865));
  assert.ok(!localHostAllowed('attacker.test:7865', 7865));
  assert.ok(localOriginAllowed(undefined, 7865));
  assert.ok(!localOriginAllowed('https://attacker.test', 7865));
  assert.ok(!localOriginAllowed('http://localhost:7866', 7865));
});
class FakeTunnel implements TunnelProvider {
  id = 'test';
  name = 'Test';
  current: TunnelStatus = { state: 'stopped' };
  fail = false;
  async checkAvailability() {
    return true;
  }
  async authenticate() {}
  async start() {
    if (this.fail) throw new Error('provider failed');
    this.current = { state: 'connected', publicUrl: 'https://actual.provider.example' };
    return { publicUrl: this.current.publicUrl! };
  }
  async stop() {
    this.current = { state: 'stopped' };
  }
  status() {
    return this.current;
  }
}
test('tunnel manager gets provider URL, starts/stops, and handles failure', async () => {
  const manager = new TunnelManager();
  const provider = new FakeTunnel();
  manager.register(provider);
  assert.equal((await manager.start('test', 7866)).publicUrl, 'https://actual.provider.example');
  assert.equal(manager.status().state, 'connected');
  await assert.rejects(manager.start('test', 7866), /Stop/);
  await manager.stop();
  assert.equal(manager.status().state, 'stopped');
  provider.fail = true;
  await assert.rejects(manager.start('test', 7866), /provider failed/);
  await manager.stop();
  await assert.rejects(manager.start('missing', 7866), /Unknown/);
});

test('concurrent tunnel startup is rejected and stopping cancels pending startup', async () => {
  const manager = new TunnelManager();
  const provider = new FakeTunnel();
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  provider.start = async () => {
    await ready;
    provider.current = { state: 'connected', publicUrl: 'https://actual.provider.example' };
    return { publicUrl: provider.current.publicUrl! };
  };
  manager.register(provider);
  const starting = manager.start('test', 7866);
  await assert.rejects(manager.start('test', 7866), /Stop/);
  await manager.stop();
  finish();
  await assert.rejects(starting, /cancelled/);
  assert.equal(provider.current.state, 'stopped');
  assert.equal(manager.status().state, 'stopped');
});

test('ngrok discovery requires a completed HTTPS endpoint event and forwards only MCP', () => {
  assert.equal(ngrokPublicUrl('{"msg":"other","url":"https://wrong.example"}'), undefined);
  for (const url of [
    'http://example.test',
    'https://user:secret@example.test',
    'https://example.test/path',
  ])
    assert.equal(ngrokPublicUrl(JSON.stringify({ msg: 'started tunnel', url })), undefined);
  const event = JSON.stringify({ msg: 'started tunnel', url: 'https://fixture.ngrok-free.app' });
  assert.equal(ngrokPublicUrl(event.slice(0, -1)), undefined);
  assert.equal(ngrokPublicUrl('noise\n' + event + '\n'), 'https://fixture.ngrok-free.app');
  assert.ok(ngrokArguments(7866).includes('http://127.0.0.1:7866'));
  assert.ok(ngrokArguments(7866).includes('--inspect=false'));
  assert.ok(!ngrokArguments(7866).some((arg) => arg.includes('7865') || arg.includes('authtoken')));
});

function nativeFixture(script: string) {
  return new NativeTunnelProvider({
    id: 'fixture',
    name: 'Fixture',
    executable: process.execPath,
    versionArguments: ['--version'],
    arguments: () => ['-e', script],
    discoverUrl: ngrokPublicUrl,
    setupMessage: 'Configure the native CLI.',
  });
}

test('native tunnel discovers split JSON logs and stops its process', async (t) => {
  const provider = nativeFixture(`
    process.stdout.write('{"msg":"started tunnel",');
    setTimeout(() => process.stdout.write('"url":"https://fixture.ngrok-free.app"}\\n'), 20);
    setInterval(() => {}, 1000);
  `);
  t.after(() => provider.stop());
  assert.equal((await provider.start(7866)).publicUrl, 'https://fixture.ngrok-free.app');
  assert.equal(provider.status().provider, 'fixture');
  assert.equal(provider.status().state, 'connected');
  await provider.stop();
  assert.equal(provider.status().state, 'stopped');
});

test('native tunnel startup failure gives setup guidance without exposing raw logs', async (t) => {
  const provider = nativeFixture('console.error("secret-not-for-dashboard"); process.exit(1)');
  t.after(() => provider.stop());
  await assert.rejects(provider.start(7866), /Configure the native CLI/);
  assert.equal(provider.status().state, 'error');
  assert.ok(!provider.status().error?.includes('secret-not-for-dashboard'));
});

test('native tunnel stop cancels startup and leaves no connected status', async (t) => {
  const provider = nativeFixture('setInterval(() => {}, 1000)');
  t.after(() => provider.stop());
  const pending = provider.start(7866);
  const rejected = assert.rejects(pending, /cancelled/);
  await provider.stop();
  await rejected;
  assert.equal(provider.status().state, 'stopped');
});
