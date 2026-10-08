// Explicit opt-in check: creates a temporary protected public tunnel and deletes its test data.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { JsonStore } from '../packages/config/store.js';
import { startRuntime, type Runtime } from '../packages/daemon/runtime.js';
const provider = process.argv[2];
if (!['ngrok', 'cloudflare'].includes(provider)) throw new Error('Choose ngrok or cloudflare.');
async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}
const directory = await mkdtemp(
  join(process.platform === 'win32' ? homedir() : tmpdir(), 'mcp-code-live-'),
);
let runtime: Runtime | undefined;
let client: Client | undefined;
try {
  const config = join(directory, 'config');
  const store = await new JsonStore(config).load();
  store.state.settings.uiPort = await port();
  store.state.settings.mcpPort = await port();
  await store.save();
  runtime = await startRuntime(config);
  const local = `http://127.0.0.1:${runtime.info.uiPort}`;
  const { csrf } = await (await fetch(local + '/api/bootstrap')).json();
  async function api(path: string, body: unknown) {
    const response = await fetch(local + '/api' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-code-csrf': csrf },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Local API returned ${response.status}`);
    return result;
  }
  const workspaces = [];
  for (const name of ['Approved fixture', 'Private fixture']) {
    const path = join(directory, name);
    await mkdir(path);
    await writeFile(join(path, 'identity.txt'), name);
    workspaces.push(await api('/workspaces', { name, path }));
  }
  console.log(`Starting temporary ${provider} tunnel with isolated fixture workspaces…`);
  const { publicUrl } = await api('/tunnels/start', { provider });
  async function remote(path: string, options: RequestInit = {}) {
    return fetch(publicUrl + path, {
      ...options,
      headers: { 'ngrok-skip-browser-warning': 'mcp-code-live-check', ...options.headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  }
  const metaResponse = await remote('/.well-known/oauth-protected-resource/mcp');
  assert.equal(metaResponse.status, 200, 'Public metadata must be reachable');
  const metadata = await metaResponse.json();
  assert.equal(metadata.resource, publicUrl + '/mcp');
  assert.equal((await remote('/api/status')).status, 401);
  assert.equal((await remote('/mcp', { method: 'POST' })).status, 401);
  const loginCode = await api('/remote/code', {});
  const login = await remote('/owner/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: publicUrl },
    body: JSON.stringify({ code: loginCode.code }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (await remote('/api/status', { headers: { cookie, 'x-mcp-code-csrf': csrf } })).status,
    200,
  );
  const callback = 'https://example.com/mcp-code-live-callback';
  const registration = await remote('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'MCP Code live verification',
      redirect_uris: [callback],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(registration.status, 201);
  const registered = await registration.json();
  const verifier = randomBytes(48).toString('base64url');
  const authorization = await remote(
    '/authorize?' +
      new URLSearchParams({
        client_id: registered.client_id,
        redirect_uri: callback,
        response_type: 'code',
        scope: 'mcp:access',
        state: 'live-check',
        resource: metadata.resource,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }),
  );
  const consent = new URL(authorization.headers.get('location')!);
  assert.equal(consent.origin, publicUrl);
  const decision = await remote(
    `/api/oauth/requests/${consent.hash.slice('#oauth='.length)}/decision`,
    {
      method: 'POST',
      headers: {
        cookie,
        'x-mcp-code-csrf': csrf,
        'content-type': 'application/json',
        origin: publicUrl,
      },
      body: JSON.stringify({ approved: true, workspaceIds: [workspaces[0].id] }),
    },
  );
  assert.equal(decision.status, 200);
  const redirect = new URL((await decision.json()).redirectUrl);
  assert.equal(redirect.searchParams.get('state'), 'live-check');
  async function token(parameters: Record<string, string>) {
    const response = await remote('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: registered.client_id,
        resource: metadata.resource,
        ...parameters,
      }),
    });
    assert.equal(response.status, 200, 'OAuth token exchange must succeed');
    return response.json();
  }
  const issued = await token({
    grant_type: 'authorization_code',
    code: redirect.searchParams.get('code')!,
    code_verifier: verifier,
    redirect_uri: callback,
  });
  client = new Client({ name: 'live-check', version: '1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(metadata.resource), {
      requestInit: {
        headers: {
          authorization: `Bearer ${issued.access_token}`,
          'ngrok-skip-browser-warning': 'mcp-code-live-check',
        },
      },
    }),
  );
  const listed = await client.callTool({ name: 'list_workspaces', arguments: {} });
  assert.deepEqual(
    (listed.structuredContent as any).workspaces.map((w: any) => w.id),
    [workspaces[0].id],
  );
  const read = await client.callTool({
    name: 'read_file',
    arguments: { workspaceId: workspaces[0].id, path: 'identity.txt' },
  });
  assert.equal((read.structuredContent as any).text, 'Approved fixture');
  const denied = await client.callTool({
    name: 'read_file',
    arguments: { workspaceId: workspaces[1].id, path: 'identity.txt' },
  });
  assert.equal(denied.isError, true);
  await client.close();
  client = undefined;
  const renewed = await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token });
  async function ping(access: string) {
    return remote('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
  }
  assert.equal((await ping(issued.access_token)).status, 401);
  assert.equal((await ping(renewed.access_token)).status, 200);
  assert.equal(
    (
      await remote('/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: registered.client_id,
          token: renewed.refresh_token,
        }),
      })
    ).status,
    200,
  );
  assert.equal((await ping(renewed.access_token)).status, 401);
  console.log(
    `PASS: ${provider} public gateway, owner login, OAuth, official MCP SDK client, Docker read, workspace denial, refresh and revocation.`,
  );
} finally {
  await client?.close().catch(() => {});
  await runtime?.stop();
  await rm(directory, { recursive: true, force: true });
  console.log('Temporary runtime, tunnel, and fixture data cleaned up.');
}
