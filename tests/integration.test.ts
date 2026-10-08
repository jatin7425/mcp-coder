import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { JsonStore } from '../packages/config/store.js';
import { startRuntime } from '../packages/daemon/runtime.js';
import { DockerSandbox } from '../packages/sandbox/docker.js';
import { defaultPermissions } from '../packages/shared/types.js';
const exec = promisify(execFile);
async function port() {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const n = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return n;
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test('real Docker + MCP + management lifecycle', async (t) => {
  const dir = await mkdtemp(
    join(process.platform === 'win32' ? homedir() : tmpdir(), 'mcp-code-integration-'),
  );
  let closeRuntime = async () => {};
  let closeClient = async () => {};
  t.after(async () => {
    try {
      await closeClient();
      await closeRuntime();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  const config = join(dir, 'config'),
    project = join(dir, 'project');
  await mkdir(project);
  const docker = new DockerSandbox(config);
  const ready = await docker.availability();
  if (!ready.available || !ready.imageReady) {
    if (process.env.MCP_CODE_REQUIRE_DOCKER === '1')
      throw new Error('This job requires a ready Linux Docker engine and sandbox image.');
    t.skip('Docker and mcp-code-sandbox:0.1 image required. Run npm run sandbox:build.');
    return;
  }
  await writeFile(join(project, 'sum.js'), 'module.exports = (a, b) => a - b;\n');
  await writeFile(
    join(project, 'test.cjs'),
    "const assert=require('node:assert/strict');assert.equal(require('./sum.js')(2,3),5);console.log('test passed');\n",
  );
  await writeFile(join(dir, 'host-secret.txt'), 'HOST_SECRET_SHOULD_NOT_BE_READ');
  try {
    await symlink(join(dir, 'host-secret.txt'), join(project, 'escape'));
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM')
      throw error;
    // Create the file symlink through the Linux sandbox on Windows without host Developer Mode.
    const { stdout } = await exec('docker', [
      'run',
      '--rm',
      '--mount',
      `type=bind,src=${project},dst=/workspace`,
      'mcp-code-sandbox:0.1',
      'ln',
      '-s',
      '/outside-host-secret',
      '/workspace/escape',
    ]);
  }
  const store = await new JsonStore(config).load();
  store.state.settings.uiPort = await port();
  store.state.settings.mcpPort = await port();
  await store.save();
  const orphanName = 'mcp-code-orphan-' + Date.now();
  await exec('docker', [
    'run',
    '-d',
    '--label',
    `mcp-code.installation=${docker.label}`,
    '--name',
    orphanName,
    'mcp-code-sandbox:0.1',
    'sleep',
    '60',
  ]);
  const runtime = await startRuntime(config);
  await assert.rejects(exec('docker', ['inspect', orphanName]));
  closeRuntime = () => runtime.stop();
  const base = `http://127.0.0.1:${runtime.info.uiPort}`,
    mcpUrl = `http://127.0.0.1:${runtime.info.mcpPort}/mcp`;
  const csrf = (await (await fetch(base + '/api/bootstrap')).json()).csrf;
  async function api(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { 'x-mcp-code-csrf': csrf, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  }
  const workspace = await api('/workspaces', 'POST', { path: project, name: 'Fixture' });
  const issued = await api('/tokens', 'POST', {
    name: 'Integration client',
    workspaceId: workspace.id,
    permissions: defaultPermissions,
    expiresInHours: 1,
  });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
  });
  const client = new Client({ name: 'mcp-code-test', version: '1.0' });
  await client.connect(transport);
  closeClient = () => client.close();
  async function call(name: string, args: Record<string, unknown> = {}) {
    return client.callTool({ name, arguments: args });
  }
  function data(result: Awaited<ReturnType<typeof call>>) {
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent as any;
  }
  await t.test('actual MCP initialization, discovery and workspace info', async () => {
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'list_workspaces'));
    assert.equal(listed.tools.length, 8);
    const info = data(await call('workspace_info'));
    assert.equal(info.path, '/workspace');
    assert.ok(!JSON.stringify(info).includes(project));
  });
  await t.test(
    'client inspects, edits, runs failing tests, fixes project and verifies',
    async () => {
      assert.match(data(await call('read_file', { path: 'sum.js' })).text, /a - b/);
      const failing = data(await call('terminal_execute', { command: 'node test.cjs' }));
      assert.notEqual(failing.exitCode, 0);
      const fixed = data(
        await call('terminal_execute', {
          command:
            "sed -i 's/a - b/a + b/' sum.js && node test.cjs && git init -q && git status --short",
        }),
      );
      assert.equal(fixed.exitCode, 0);
      assert.match(fixed.stdout, /test passed/);
      assert.match(await readFile(join(project, 'sum.js'), 'utf8'), /a \+ b/);
      const search = data(await call('search_text', { query: 'module.exports' }));
      assert.match(search.matches, /sum.js/);
      const tree = data(await call('directory_tree'));
      assert.ok(tree.entries.some((x: any) => x.path === 'sum.js'));
    },
  );
  await t.test(
    'host secrets, symlink escape, traversal, Docker socket and network are unavailable',
    async () => {
      for (const path of ['escape', '../host-secret.txt', '/etc/passwd']) {
        const result = await call('read_file', { path });
        assert.equal(result.isError, true);
      }
      const out = data(
        await call('terminal_execute', {
          command: `test ! -e /var/run/docker.sock && test ! -e /workspace/escape && test ! -e /home/agent/.ssh && python3 -c 'import socket; s=socket.socket(); s.settimeout(1); s.connect(("1.1.1.1",53))'`,
        }),
      );
      assert.notEqual(out.exitCode, 0);
      assert.match(out.stderr, /Network is unreachable/);
      const status = await api('/status');
      assert.ok(!JSON.stringify(status.tokens).includes(issued.token));
    },
  );
  await t.test('read-only mount refuses filesystem writes', async () => {
    const result = await docker.execute({
      id: crypto.randomUUID(),
      workspace: runtime.store.state.workspaces[0],
      permissions: { ...defaultPermissions, write: false },
      input: {
        command: 'echo denied > /workspace/no-write.txt',
        timeout: 10000,
        cwd: '/workspace',
      },
      signal: new AbortController().signal,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Read-only file system/);
    await assert.rejects(access(join(project, 'no-write.txt')));
  });
  await t.test('timeout and bounded stdout/stderr', async () => {
    const result = data(await call('terminal_execute', { command: 'sleep 30', timeout: 700 }));
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
    const output = data(
      await call('terminal_execute', {
        command: 'python3 -c \'import sys; sys.stdout.write("x"*400000);sys.stderr.write("err")\'',
      }),
    );
    assert.equal(output.truncated, true);
    assert.ok(output.stdout.length + output.stderr.length <= 262144);
  });
  await t.test('background cancellation destroys container and child process', async () => {
    const job = data(
      await call('terminal_execute', { command: 'sleep 30 & wait', background: true }),
    );
    for (let i = 0; i < 30; i++) {
      try {
        await exec('docker', ['inspect', `mcp-code-${job.id}`]);
        break;
      } catch {
        await delay(100);
      }
    }
    const cancelled = data(await call('terminal_cancel', { id: job.id }));
    assert.equal(cancelled.result.cancelled, true);
    assert.equal(cancelled.result.exitCode, 130);
    await assert.rejects(exec('docker', ['inspect', `mcp-code-${job.id}`]));
  });
  await t.test('client disconnect cancels a synchronous command and its process tree', async () => {
    const controller = new AbortController();
    const request = fetch(mcpUrl.replace('/mcp', '/bridge/terminal_execute'), {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'sleep 30 & wait' }),
      signal: controller.signal,
    }).catch(() => undefined);
    let running: any;
    for (let i = 0; i < 30; i++) {
      running = runtime.terminals
        .list()
        .find((j) => j.command === 'sleep 30 & wait' && j.status === 'running');
      if (running) break;
      await delay(100);
    }
    assert.ok(running);
    controller.abort();
    await request;
    for (let i = 0; i < 50; i++) {
      if (runtime.terminals.status(running.id).status === 'completed') break;
      await delay(100);
    }
    assert.equal(runtime.terminals.status(running.id).result?.cancelled, true);
    await assert.rejects(exec('docker', ['inspect', `mcp-code-${running.id}`]));
  });
  await t.test(
    'read-only tokens can inspect but cannot execute arbitrary commands or cancel other clients',
    async () => {
      const ro = await api('/tokens', 'POST', {
        name: 'Read only',
        workspaceId: workspace.id,
        permissions: { ...defaultPermissions, write: false, execute: false, git: false },
      });
      const other = new Client({ name: 'readonly', version: '1' });
      await other.connect(
        new StreamableHTTPClientTransport(new URL(mcpUrl), {
          requestInit: { headers: { authorization: `Bearer ${ro.token}` } },
        }),
      );
      try {
        assert.equal(
          (await other.callTool({ name: 'terminal_execute', arguments: { command: 'cat sum.js' } }))
            .isError,
          true,
        );
        assert.equal(
          (await other.callTool({ name: 'read_file', arguments: { path: 'sum.js' } })).isError,
          undefined,
        );
        const mine = data(
          await call('terminal_execute', { command: 'echo owner', background: true }),
        );
        assert.equal(
          (await other.callTool({ name: 'terminal_status', arguments: { id: mine.id } })).isError,
          true,
        );
      } finally {
        await other.close();
      }
    },
  );
  await t.test('approval queue requires approval, denial is audited', async () => {
    await api(`/workspaces/${workspace.id}`, 'PATCH', { approvalMode: 'ask' });
    const pending = data(await call('terminal_execute', { command: 'echo approved' }));
    assert.equal(pending.status, 'awaiting-approval');
    await api(`/jobs/${pending.id}/approval`, 'POST', { approved: true });
    let result: any;
    for (let i = 0; i < 40; i++) {
      result = data(await call('terminal_status', { id: pending.id }));
      if (result.status === 'completed') break;
      await delay(100);
    }
    assert.match(result.result.stdout, /approved/);
    const denied = data(await call('terminal_execute', { command: 'echo forbidden' }));
    await api(`/jobs/${denied.id}/approval`, 'POST', { approved: false });
    assert.equal(data(await call('terminal_status', { id: denied.id })).status, 'denied');
    await api(`/workspaces/${workspace.id}`, 'PATCH', { approvalMode: 'autonomous' });
  });
  await t.test(
    'management endpoints resist cross-origin, unauthenticated and tunnel-port access',
    async () => {
      assert.equal((await fetch(base + '/api/status')).status, 403);
      assert.equal(
        (await fetch(base + '/api/bootstrap', { headers: { origin: 'https://evil.example' } }))
          .status,
        403,
      );
      const badHost = await new Promise<number | undefined>((resolve) => {
        const req = request(
          base + '/api/bootstrap',
          { headers: { host: 'evil.example' } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.end();
      });
      assert.equal(badHost, 403);
      assert.equal(
        (
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await fetch(mcpUrl, {
            method: 'POST',
            headers: { authorization: 'Bearer mcpc_invalid', 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await fetch(mcpUrl.replace('/mcp', '/api/status'), {
            headers: { authorization: `Bearer ${issued.token}` },
          })
        ).status,
        401,
      );
    },
  );
  await t.test('stdio transport bridges the same authenticated runtime', async () => {
    const stdioClient = new Client({ name: 'stdio-test', version: '1' });
    const stdio = new StdioClientTransport({
      command: process.execPath,
      args: ['dist/apps/cli/stdio.js'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        MCP_CODE_HOME: config,
        MCP_CODE_TOKEN: issued.token,
      },
      stderr: 'pipe',
    });
    await stdioClient.connect(stdio);
    assert.equal(
      (await stdioClient.callTool({ name: 'workspace_info', arguments: {} })).isError,
      undefined,
    );
    await stdioClient.close();
  });
  await t.test('permissions changes, expiration and revocation cancel access', async () => {
    const job = data(await call('terminal_execute', { command: 'sleep 30', background: true }));
    await api(`/workspaces/${workspace.id}`, 'PATCH', {
      permissions: { ...defaultPermissions, git: false },
    });
    assert.equal(data(await call('terminal_status', { id: job.id })).result.cancelled, true);
    assert.equal((await call('terminal_execute', { command: 'echo no' })).isError, true);
    await api(`/workspaces/${workspace.id}`, 'PATCH', { permissions: defaultPermissions });
    const short = await api('/tokens', 'POST', {
      name: 'Expired',
      workspaceId: workspace.id,
      permissions: defaultPermissions,
      expiresInHours: 0.01,
    });
    runtime.store.state.tokens.find((t) => t.id === short.record.id)!.expiresAt = new Date(
      0,
    ).toISOString();
    assert.equal(
      (
        await fetch(mcpUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${short.token}`, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
    await api(`/tokens/${issued.record.id}/revoke`, 'POST');
    assert.equal(
      (
        await fetch(mcpUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
  });
  await t.test(
    'duplicate prevention and clean shutdown release locks and remove all containers',
    async () => {
      await assert.rejects(startRuntime(config), /already running/);
      await runtime.stop();
      await assert.rejects(access(join(config, 'daemon.lock')));
      const { stdout } = await exec('docker', [
        'ps',
        '-aq',
        '--filter',
        `label=mcp-code.installation=${docker.label}`,
      ]);
      assert.equal(stdout.trim(), '');
      await assert.rejects(fetch(base + '/api/health'));
    },
  );
});
