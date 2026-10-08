import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { TunnelManager } from '../packages/tunnel-manager/manager.js';
import type { TunnelStatus } from '../packages/tunnel-manager/provider.js';
import { JsonStore } from '../packages/config/store.js';
import { startRuntime } from '../packages/daemon/runtime.js';
async function port() {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const n = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return n;
}
test('dashboard workflows and responsive layout in Chromium', async (t) => {
  const dir = await mkdtemp(
    join(process.platform === 'win32' ? homedir() : tmpdir(), 'mcp-code-browser-'),
  );
  let closeRuntime = async () => {};
  let closeBrowser = async () => {};
  t.after(async () => {
    try {
      await closeBrowser();
      await closeRuntime();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  const config = join(dir, 'config'),
    project = join(dir, 'project');
  await mkdir(project);
  const store = await new JsonStore(config).load();
  store.state.settings.uiPort = await port();
  store.state.settings.mcpPort = await port();
  await store.save();
  const tunnels = new TunnelManager();
  let tunnelStatus: TunnelStatus = { state: 'stopped' };
  tunnels.register({
    id: 'fixture',
    name: 'Fixture',
    async checkAvailability() {
      return true;
    },
    async authenticate() {},
    async start() {
      tunnelStatus = {
        state: 'connected',
        provider: 'fixture',
        publicUrl: 'https://fixture.example',
      };
      return { publicUrl: tunnelStatus.publicUrl! };
    },
    async stop() {
      tunnelStatus = { state: 'stopped' };
    },
    status() {
      return tunnelStatus;
    },
  });
  const runtime = await startRuntime(config, { tunnels });
  closeRuntime = () => runtime.stop();
  let executablePath = process.env.MCP_CODE_CHROME;
  if (!executablePath && !process.env.CI && process.platform === 'linux') {
    try {
      await access('/usr/bin/google-chrome');
      executablePath = '/usr/bin/google-chrome';
    } catch {}
  }
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  });
  closeBrowser = () => browser.close();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${runtime.info.uiPort}`);
  await page.getByRole('heading', { name: 'Your local coding workspace' }).waitFor();
  await page.screenshot({ path: join(tmpdir(), 'mcp-code-dashboard.png'), fullPage: true });
  await page.getByRole('link', { name: 'Workspaces', exact: true }).click();
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project folder' }).fill(project);
  await page.getByRole('textbox', { name: 'Workspace name' }).fill('Browser fixture');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Add workspace', exact: true })
    .click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Resources', exact: true }).click();
  await page.getByLabel('Memory (MB)').fill('2048');
  await page.getByLabel('CPU cores').fill('2');
  await page.getByLabel('Maximum command time (seconds)').fill('600');
  await page.getByRole('button', { name: 'Save resources' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(runtime.store.state.workspaces[0].resources, {
    memoryMb: 2048,
    cpus: 2,
    timeoutSeconds: 600,
  });

  await page.getByRole('link', { name: 'Permissions', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Workspace access' }).waitFor();
  await page.getByRole('checkbox', { name: 'Network access' }).check();
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await page.getByRole('status').filter({ hasText: 'Permissions saved' }).waitFor();
  assert.equal(runtime.store.state.workspaces[0].permissions.network, true);
  await page.getByRole('checkbox', { name: 'Network access' }).uncheck();
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await page.getByRole('link', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Create access token', exact: true }).click();
  await page.getByRole('textbox', { name: 'Client name' }).fill('Browser client');
  await page.getByRole('dialog').getByRole('button', { name: 'Create token', exact: true }).click();
  await page.getByRole('heading', { name: 'Save your access token' }).waitFor();
  assert.equal(runtime.store.state.tokens.length, 1);
  await page.getByRole('button', { name: 'I have saved the token' }).click();
  await page.getByRole('button', { name: 'Rotate', exact: true }).click();
  await page.getByRole('heading', { name: 'Save your access token' }).waitFor();
  await page.getByRole('button', { name: 'I have saved the token' }).click();
  assert.ok(runtime.store.state.tokens[0].revokedAt);
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Token revoked' }).waitFor();
  assert.ok(runtime.store.state.tokens[1].revokedAt);
  const localBase = `http://127.0.0.1:${runtime.info.uiPort}`;
  const { csrf } = await (await fetch(localBase + '/api/bootstrap')).json();
  const localApi = async (path: string, body: unknown) => {
    const response = await fetch(localBase + '/api' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-code-csrf': csrf },
      body: JSON.stringify(body),
    });
    assert.ok(response.ok);
    return response.json();
  };
  const secondProject = join(dir, 'second-project');
  await mkdir(secondProject);
  await localApi('/workspaces', { path: secondProject, name: 'Second workspace' });
  const verifier = 'browser-fixture-'.repeat(5);
  const clientResponse = await fetch(`http://127.0.0.1:${runtime.info.mcpPort}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Browser OAuth agent',
      redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const oauthClient = await clientResponse.json();
  const query = new URLSearchParams({
    client_id: oauthClient.client_id,
    redirect_uri: oauthClient.redirect_uris[0],
    response_type: 'code',
    state: 'browser-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: `http://127.0.0.1:${runtime.info.mcpPort}/mcp`,
  });
  const authorized = await fetch(`http://127.0.0.1:${runtime.info.mcpPort}/authorize?${query}`, {
    redirect: 'manual',
  });
  await page.goto(authorized.headers.get('location')!);
  await page.getByRole('heading', { name: 'Approve agent access', exact: true }).waitFor();
  assert.equal(await page.locator('[data-consent-workspace]').count(), 2);
  assert.equal(await page.locator('[data-consent-workspace]:checked').count(), 0);
  await page.getByRole('button', { name: 'Allow selected workspaces' }).click();
  await page.getByRole('status').filter({ hasText: 'Select at least one workspace' }).waitFor();
  await page.locator('[data-consent-workspace]').first().check();
  await page.screenshot({ path: join(tmpdir(), 'mcp-code-oauth-consent.png'), fullPage: true });
  let callback: URL | undefined;
  await page.route('https://client.example/callback**', async (route) => {
    callback = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<h1>Agent connected</h1>',
    });
  });
  await page.getByRole('button', { name: 'Allow selected workspaces' }).click();
  await page.getByRole('heading', { name: 'Agent connected' }).waitFor();
  assert.equal(callback!.searchParams.get('state'), 'browser-state');
  const exchanged = await fetch(`http://127.0.0.1:${runtime.info.mcpPort}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: oauthClient.client_id,
      grant_type: 'authorization_code',
      code: callback!.searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: oauthClient.redirect_uris[0],
      resource: `http://127.0.0.1:${runtime.info.mcpPort}/mcp`,
    }),
  });
  assert.equal(exchanged.status, 200);
  assert.deepEqual(runtime.store.state.tokens.at(-1)!.oauth!.workspaceIds, [
    runtime.store.state.workspaces[0].id,
  ]);
  await page.goto(`http://127.0.0.1:${runtime.info.uiPort}/#remote`);
  await page.getByRole('link', { name: 'Remote access', exact: true }).first().click();
  await page.getByRole('tab', { name: 'Local', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Local', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(
    await page.getByRole('tab', { name: 'Cloudflare', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await page.getByRole('tab', { name: 'ngrok', exact: true }).click();
  await page.getByRole('heading', { name: 'ngrok', exact: true }).waitFor();
  await page.route('**/api/tunnels/start', async (route) => {
    assert.equal(route.request().postDataJSON().provider, 'ngrok');
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Configure the native ngrok CLI.' }),
    });
  });
  await page.getByRole('button', { name: 'Start ngrok', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Configure the native ngrok CLI.' }).waitFor();
  await page.unroute('**/api/tunnels/start');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(tmpdir(), 'mcp-code-ngrok.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Browser sees an HTTPS tunnel origin; route forwarding exercises the real gateway
  // locally without opening a public tunnel or requiring provider account credentials.
  await localApi('/tunnels/start', { provider: 'fixture' });
  const code = await localApi('/remote/code', {});
  const remotePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  remotePage.on('pageerror', (error) => errors.push(error.message));
  await remotePage.route('https://fixture.example/**', async (route) => {
    const incoming = route.request();
    const headers = await incoming.allHeaders();
    headers.host = 'fixture.example';
    const response = await new Promise<{
      status: number;
      headers: Record<string, string>;
      body: Buffer;
    }>((resolve, reject) => {
      const url = new URL(incoming.url());
      const req = request(
        `http://127.0.0.1:${runtime.info.mcpPort}${url.pathname}${url.search}`,
        { method: incoming.method(), headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const responseHeaders: Record<string, string> = {};
            for (const [name, value] of Object.entries(res.headers))
              if (
                value !== undefined &&
                !['connection', 'transfer-encoding', 'content-length', 'content-encoding'].includes(
                  name,
                )
              )
                responseHeaders[name] = Array.isArray(value) ? value.join('\n') : value;
            resolve({
              status: res.statusCode!,
              headers: responseHeaders,
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      req.on('error', reject);
      req.end(incoming.postDataBuffer() || undefined);
    });
    await route.fulfill(response);
  });
  const remoteQuery = new URLSearchParams(query);
  remoteQuery.set('resource', 'https://fixture.example/mcp');
  const remoteAuthorization = await fetch(
    `http://127.0.0.1:${runtime.info.mcpPort}/authorize?${remoteQuery}`,
    { redirect: 'manual' },
  );
  await remotePage.goto(remoteAuthorization.headers.get('location')!);
  await remotePage.getByRole('heading', { name: 'Connect to your workspace runtime' }).waitFor();
  await remotePage.screenshot({ path: join(tmpdir(), 'mcp-code-owner-login.png'), fullPage: true });
  await remotePage.getByLabel('Owner login code').fill(code.code);
  await remotePage.getByRole('button', { name: 'Open dashboard' }).click();
  await remotePage.getByRole('heading', { name: 'Approve agent access', exact: true }).waitFor();
  assert.equal(await remotePage.locator('[data-consent-workspace]:checked').count(), 0);
  assert.equal(await remotePage.locator('[data-consent-workspace]').count(), 2);
  await remotePage.locator('[data-consent-workspace]').nth(1).check();
  let remoteCallback: URL | undefined;
  await remotePage.route('https://client.example/callback**', async (route) => {
    remoteCallback = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<h1>Remote agent connected</h1>',
    });
  });
  await remotePage.getByRole('button', { name: 'Allow selected workspaces' }).click();
  await remotePage.getByRole('heading', { name: 'Remote agent connected' }).waitFor();
  const remoteExchange = await fetch(`http://127.0.0.1:${runtime.info.mcpPort}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: oauthClient.client_id,
      grant_type: 'authorization_code',
      code: remoteCallback!.searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: oauthClient.redirect_uris[0],
      resource: 'https://fixture.example/mcp',
    }),
  });
  assert.equal(remoteExchange.status, 200);
  assert.deepEqual(runtime.store.state.tokens.at(-1)!.oauth!.workspaceIds, [
    runtime.store.state.workspaces[1].id,
  ]);
  await remotePage.goto('https://fixture.example/#remote');
  await remotePage.getByRole('link', { name: 'Remote access', exact: true }).first().click();
  await remotePage.getByRole('heading', { name: 'One public address' }).waitFor();
  await remotePage.getByRole('tab', { name: 'Fixture', exact: true }).waitFor();
  assert.ok(await remotePage.getByRole('button', { name: 'Sign out of dashboard' }).isVisible());
  await remotePage.getByRole('button', { name: 'Sign out of dashboard' }).click();
  await remotePage.getByRole('heading', { name: 'Connect to your workspace runtime' }).waitFor();
  await remotePage.close();
  await localApi('/tunnels/stop', {});
  await page.getByRole('link', { name: 'Remote access', exact: true }).first().click();
  await page.getByRole('button', { name: 'Check connections', exact: true }).click();
  await page.getByText('Accepting authenticated connections.', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'ngrok', exact: true }).click();
  await page.getByRole('button', { name: 'Configure address', exact: true }).click();
  await page.getByLabel('Address mode').selectOption('ngrok-domain');
  await page.getByLabel('Public HTTPS address').fill('https://mcp.example.com');
  await page.getByRole('button', { name: 'Save address', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(runtime.store.state.tunnelConfigs?.ngrok.mode, 'ngrok-domain');
  await page.route('**/api/workspaces/*/changes', (route) =>
    route.fulfill({
      json: {
        repository: true,
        files: [{ status: ' M', path: '<script>bad()</script>' }],
        staged: '',
        working: '+<script>bad()</script>',
        untracked: [],
        truncated: false,
      },
    }),
  );
  await page.getByRole('link', { name: 'Changes', exact: true }).click();
  await page.getByRole('button', { name: 'Load changes', exact: true }).click();
  await page.getByRole('heading', { name: 'Working changes', exact: true }).waitFor();
  assert.ok(await page.getByText('+<script>bad()</script>', { exact: true }).isVisible());
  await page.screenshot({ path: join(tmpdir(), 'mcp-code-changes.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'Connections', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Remove client', exact: true }).first().click();
  await page.getByText('No registered OAuth clients.', { exact: true }).waitFor();
  for (const name of ['Remote access', 'Activity', 'Settings', 'Dashboard']) {
    await page.getByRole('link', { name, exact: true }).first().click();
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: join(tmpdir(), 'mcp-code-configured.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(tmpdir(), 'mcp-code-mobile.png'), fullPage: true });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'mobile page must not overflow horizontally',
  );
  await page.getByRole('link', { name: 'Permissions', exact: true }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
});
