import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createServer } from 'node:net';
const exec = promisify(execFile);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check with npm run test:package.');
const npmRun = (args, options) => exec(process.execPath, [npmCli, ...args], options);
async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
const directory = await mkdtemp(
  join(process.platform === 'win32' ? homedir() : tmpdir(), 'mcp-code-package-'),
);
let shutdown = async () => {};
try {
  const { stdout } = await npmRun(['pack', '--ignore-scripts', '--json'], {
    maxBuffer: 1024 * 1024,
  });
  const [manifest] = JSON.parse(stdout);
  assert.ok(manifest.files.some((file) => file.path === 'apps/web/index.html'));
  assert.ok(manifest.files.some((file) => file.path === '.dockerignore'));
  assert.ok(
    !manifest.files.some(
      (file) => file.path.includes('.local') || file.path.includes('state.json'),
    ),
  );
  await npmRun(
    [
      'install',
      '--prefix',
      directory,
      resolve(manifest.filename),
      '--ignore-scripts',
      '--cache',
      join(tmpdir(), 'mcp-code-package-cache'),
      '--fetch-retries=0',
      '--fetch-timeout=20000',
    ],
    { timeout: 90000, maxBuffer: 1024 * 1024 },
  );
  const config = join(directory, 'state');
  await mkdir(config);
  const uiPort = await port(),
    mcpPort = await port();
  await writeFile(
    join(config, 'state.json'),
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [],
      tokens: [],
      audit: [],
      settings: { uiPort, mcpPort, retentionDays: 7 },
    }),
  );
  const entry = join(directory, 'node_modules/mcp-code/dist/apps/cli/main.js');
  const env = { ...process.env, MCP_CODE_HOME: config, MCP_CODE_NO_BROWSER: '1' };
  const first = await exec(process.execPath, [entry], { env, timeout: 30000 });
  assert.match(first.stdout, /Runtime started/);
  const daemon = JSON.parse(await readFile(join(config, 'daemon.json'), 'utf8'));
  const base = `http://127.0.0.1:${uiPort}`;
  const { csrf } = await (await fetch(base + '/api/bootstrap')).json();
  shutdown = async () => {
    try {
      await fetch(base + '/api/shutdown', { method: 'POST', headers: { 'x-mcp-code-csrf': csrf } });
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  };
  assert.match(await (await fetch(base)).text(), /MCP Code/);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  const second = await exec(process.execPath, [entry], { env, timeout: 10000 });
  assert.match(second.stdout, /already running/);
  assert.equal(JSON.parse(await readFile(join(config, 'daemon.json'), 'utf8')).pid, daemon.pid);
  const initial = await (
    await fetch(base + '/api/status', { headers: { 'x-mcp-code-csrf': csrf } })
  ).json();
  await access(join(directory, 'node_modules/mcp-code/Dockerfile.sandbox'));
  if (initial.sandbox.available && initial.sandbox.imageReady) {
    const buildResponse = await fetch(base + '/api/sandbox/build', {
      method: 'POST',
      headers: { 'x-mcp-code-csrf': csrf },
    });
    assert.equal(buildResponse.status, 202);
    let status;
    for (let i = 0; i < 50; i++) {
      status = await (
        await fetch(base + '/api/status', { headers: { 'x-mcp-code-csrf': csrf } })
      ).json();
      if (!status.imageBuild.running) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.match(status.imageBuild.log, /Build exited with 0/);
  } else {
    if (process.env.MCP_CODE_REQUIRE_DOCKER === '1')
      throw new Error('A ready Linux Docker engine and sandbox image are required for this job.');
    console.log(
      'Packaged image-build check skipped: no prepared Linux Docker engine. Launcher and dashboard checks still run.',
    );
  }
  await shutdown();
  shutdown = async () => {};
  await assert.rejects(access(join(config, 'daemon.lock')));
  console.log(
    `Package verified: ${manifest.filename}; dashboard assets, launcher singleton, and graceful shutdown passed (image build also checked when Docker is ready).`,
  );
} finally {
  await shutdown();
  await rm(directory, { recursive: true, force: true });
}
