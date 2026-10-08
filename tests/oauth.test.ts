import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { DockerSandbox } from '../packages/sandbox/docker.js';
import { JsonStore } from '../packages/config/store.js';
import { startRuntime } from '../packages/daemon/runtime.js';
import { TunnelManager } from '../packages/tunnel-manager/manager.js';
import type { TunnelStatus } from '../packages/tunnel-manager/provider.js';

async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const number = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return number;
}
const verifier = 'a'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
async function fixture(t: TestContext) {
  const dir = await mkdtemp(
    join(process.platform === 'win32' ? homedir() : tmpdir(), 'mcp-code-oauth-'),
  );
  const config = join(dir, 'config');
  const store = await new JsonStore(config).load();
  store.state.settings.uiPort = await port();
  store.state.settings.mcpPort = await port();
  await store.save();
  const tunnels = new TunnelManager();
  let tunnel: TunnelStatus = { state: 'stopped' };
  tunnels.register({
    id: 'fixture',
    name: 'Fixture',
    async checkAvailability() {
      return true;
    },
    async authenticate() {},
    async start() {
      tunnel = { state: 'connected', provider: 'fixture', publicUrl: 'https://fixture.example' };
      return { publicUrl: tunnel.publicUrl! };
    },
    async stop() {
      tunnel = { state: 'stopped' };
    },
    status() {
      return tunnel;
    },
  });
  let runtime = await startRuntime(config, { tunnels });
  t.after(async () => {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${store.state.settings.uiPort}`;
  const mcp = `http://127.0.0.1:${store.state.settings.mcpPort}`;
  let csrf = (await (await fetch(base + '/api/bootstrap')).json()).csrf;
  const api = async (path: string, method = 'GET', data?: unknown) => {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { 'x-mcp-code-csrf': csrf, 'content-type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const workspaces = [];
  for (const name of ['Alpha', 'Beta', 'Private']) {
    const path = join(dir, name);
    await mkdir(path);
    const created = await api('/workspaces', 'POST', { path, name });
    assert.equal(created.status, 201);
    workspaces.push(created.body);
  }
  const register = async (method = 'none') => {
    const response = await fetch(mcp + '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'OAuth fixture',
        redirect_uris: ['https://client.example/callback'],
        token_endpoint_auth_method: method,
      }),
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  const authorize = async (
    client: any,
    resource = mcp + '/mcp',
    overrides: Record<string, string> = {},
  ) => {
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: 'code',
      scope: 'mcp:access',
      state: 'fixture-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
      ...overrides,
    });
    return fetch(mcp + '/authorize?' + query, { redirect: 'manual' });
  };
  const token = async (client: any, data: Record<string, string>) => {
    const response = await fetch(mcp + '/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        ...(client.client_secret ? { client_secret: client.client_secret } : {}),
        ...data,
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  const bridge = async (access: string, tool: string, args = {}) => {
    const response = await fetch(mcp + '/bridge/' + tool, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    return { status: response.status, body: await response.json() };
  };
  const restart = async () => {
    await runtime.stop();
    runtime = await startRuntime(config, { tunnels });
    csrf = (await (await fetch(base + '/api/bootstrap')).json()).csrf;
  };
  return {
    dir,
    config,
    runtime,
    base,
    mcp,
    api,
    workspaces,
    register,
    authorize,
    token,
    bridge,
    restart,
  };
}

test('OAuth discovery, explicit workspace consent, PKCE, audience, refresh rotation and revocation', async (t) => {
  const f = await fixture(t);
  const resource = f.mcp + '/mcp';
  const unauth = await fetch(resource, { method: 'POST' });
  assert.equal(unauth.status, 401);
  assert.match(
    unauth.headers.get('www-authenticate')!,
    /resource_metadata=.*oauth-protected-resource\/mcp/,
  );
  const metadata = await (await fetch(f.mcp + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(metadata.resource, resource);
  const server = await (await fetch(f.mcp + '/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  await f.api(`/workspaces/${f.workspaces[1].id}`, 'PATCH', {
    permissions: { read: true, write: false, execute: false, git: false, network: false },
  });
  const client = await f.register();
  const otherClient = await f.register();
  const invalidRedirect = await f.authorize(client, resource, {
    redirect_uri: 'https://evil.example/callback',
  });
  assert.equal(invalidRedirect.status, 400);
  assert.equal(invalidRedirect.headers.get('location'), null);
  const badTarget = await f.authorize(client, 'https://other.example/mcp');
  assert.equal(
    new URL(badTarget.headers.get('location')!).searchParams.get('error'),
    'invalid_target',
  );
  const authorization = await f.authorize(client);
  const approval = new URL(authorization.headers.get('location')!);
  assert.equal(approval.origin, f.base);
  const id = approval.hash.slice('#oauth='.length);
  assert.equal(
    (
      await fetch(f.base + `/api/oauth/requests/${id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true, workspaceIds: [f.workspaces[0].id] }),
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.api(`/oauth/requests/${id}/decision`, 'POST', { approved: true, workspaceIds: [] }))
      .status,
    400,
  );
  const decision = await f.api(`/oauth/requests/${id}/decision`, 'POST', {
    approved: true,
    workspaceIds: f.workspaces.slice(0, 2).map((w) => w.id),
  });
  const returned = new URL(decision.body.redirectUrl);
  assert.equal(returned.searchParams.get('state'), 'fixture-state');
  const code = returned.searchParams.get('code')!;
  const exchange = {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: client.redirect_uris[0],
    resource,
  };
  assert.equal((await f.token(otherClient, exchange)).body.error, 'invalid_grant');
  assert.equal(
    (await f.token(client, { ...exchange, code_verifier: 'b'.repeat(64) })).body.error,
    'invalid_grant',
  );
  assert.equal(
    (await f.token(client, { ...exchange, resource: 'https://other.example/mcp' })).body.error,
    'invalid_target',
  );
  assert.equal(
    (await f.token(client, { ...exchange, redirect_uri: 'https://evil.example' })).body.error,
    'invalid_grant',
  );
  const issued = await f.token(client, exchange);
  assert.equal(issued.status, 200);
  assert.equal((await f.token(client, exchange)).body.error, 'invalid_grant');
  const access = issued.body.access_token;
  const listed = await f.bridge(access, 'list_workspaces');
  assert.deepEqual(
    listed.body.structuredContent.workspaces.map((w: any) => w.name),
    ['Alpha', 'Beta'],
  );
  const beta = await f.bridge(access, 'workspace_info', { workspaceId: f.workspaces[1].id });
  assert.equal(beta.body.structuredContent.name, 'Beta');
  for (const tool of ['workspace_info', 'terminal_execute', 'read_file']) {
    const result = await f.bridge(access, tool, {
      workspaceId: f.workspaces[2].id,
      command: 'pwd',
      path: 'private.txt',
    });
    assert.equal(result.body.isError, true);
    assert.match(result.body.content[0].text, /not approved/);
  }
  await t.test(
    'real sandbox reads a second approved workspace; consent ceiling survives policy expansion',
    async (t) => {
      const docker = new DockerSandbox(f.config);
      const ready = await docker.availability();
      if (!ready.available || !ready.imageReady) {
        if (process.env.MCP_CODE_REQUIRE_DOCKER === '1')
          throw new Error('Docker is required for this job.');
        t.skip('Prepared Docker image required for OAuth mount verification.');
        return;
      }
      await writeFile(join(f.workspaces[0].path, 'identity.txt'), 'Alpha only');
      await writeFile(join(f.workspaces[1].path, 'identity.txt'), 'Beta only');
      const read = await f.bridge(access, 'read_file', {
        workspaceId: f.workspaces[1].id,
        path: 'identity.txt',
      });
      assert.equal(read.body.structuredContent.text, 'Beta only');
    },
  );
  await f.api(`/workspaces/${f.workspaces[1].id}`, 'PATCH', {
    permissions: { read: true, write: true, execute: true, git: true, network: true },
  });
  const deniedExecution = await f.bridge(access, 'terminal_execute', {
    workspaceId: f.workspaces[1].id,
    command: 'pwd',
  });
  assert.equal(deniedExecution.body.isError, true);
  assert.match(deniedExecution.body.content[0].text, /requires/);
  // Changing the dashboard's active project must not broaden or switch an OAuth grant.
  await f.api(`/workspaces/${f.workspaces[2].id}/activate`, 'POST');
  assert.equal((await f.bridge(access, 'workspace_info')).body.structuredContent.name, 'Alpha');
  const status = (await f.api('/status')).body;
  assert.ok(!JSON.stringify(status.tokens).includes('refreshHash'));
  const stateText = await readFile(join(f.config, 'state.json'), 'utf8');
  assert.ok(!stateText.includes(access) && !stateText.includes(issued.body.refresh_token));
  const refreshRequest = {
    grant_type: 'refresh_token',
    refresh_token: issued.body.refresh_token,
    resource,
  };
  assert.equal(
    (await f.token(client, { ...refreshRequest, scope: 'admin' })).body.error,
    'invalid_scope',
  );
  const renewed = await f.token(client, refreshRequest);
  assert.equal(renewed.status, 200);
  assert.equal((await f.bridge(access, 'workspace_info')).status, 401);
  assert.equal((await f.bridge(renewed.body.access_token, 'workspace_info')).status, 200);
  assert.equal((await f.token(client, refreshRequest)).body.error, 'invalid_grant');
  assert.equal((await f.bridge(renewed.body.access_token, 'workspace_info')).status, 401);
  const denied = await f.authorize(client);
  const denyId = new URL(denied.headers.get('location')!).hash.slice('#oauth='.length);
  const denial = await f.api(`/oauth/requests/${denyId}/decision`, 'POST', { approved: false });
  assert.equal(new URL(denial.body.redirectUrl).searchParams.get('error'), 'access_denied');
  assert.equal(new URL(denial.body.redirectUrl).searchParams.get('state'), 'fixture-state');
});

test('confidential clients persist only hashed secrets; grants renew after restart and local revoke stops refresh', async (t) => {
  const f = await fixture(t);
  const client = await f.register('client_secret_post');
  const authorization = await f.authorize(client);
  const id = new URL(authorization.headers.get('location')!).hash.slice('#oauth='.length);
  const decision = await f.api(`/oauth/requests/${id}/decision`, 'POST', {
    approved: true,
    workspaceIds: [f.workspaces[0].id],
  });
  const code = new URL(decision.body.redirectUrl).searchParams.get('code')!;
  const params = {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: client.redirect_uris[0],
    resource: f.mcp + '/mcp',
  };
  assert.equal((await f.token({ ...client, client_secret: 'wrong' }, params)).status, 401);
  const issued = await f.token(client, params);
  assert.equal(issued.status, 200);
  const text = await readFile(join(f.config, 'state.json'), 'utf8');
  assert.ok(!text.includes(client.client_secret));
  await f.restart();
  const refreshed = await f.token(client, {
    grant_type: 'refresh_token',
    refresh_token: issued.body.refresh_token,
    resource: f.mcp + '/mcp',
  });
  assert.equal(refreshed.status, 200);
  const records = (await f.api('/status')).body.tokens;
  assert.equal(records.length, 1);
  await f.api(`/tokens/${records[0].id}/revoke`, 'POST');
  assert.equal((await f.bridge(refreshed.body.access_token, 'workspace_info')).status, 401);
  assert.equal(
    (
      await f.token(client, {
        grant_type: 'refresh_token',
        refresh_token: refreshed.body.refresh_token,
        resource: f.mcp + '/mcp',
      })
    ).body.error,
    'invalid_grant',
  );
});

function publicRequest(
  base: string,
  path: string,
  method = 'GET',
  data?: unknown,
  headers: Record<string, string> = {},
) {
  return new Promise<{
    status: number;
    headers: import('node:http').IncomingHttpHeaders;
    text: string;
  }>((resolve, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = request(
      base + path,
      {
        method,
        headers: {
          host: 'fixture.example',
          ...(body
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body).toString(),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('one tunnel serves owner-gated dashboard, OAuth and MCP without crossing authentication boundaries', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api('/tunnels/start', 'POST', { provider: 'fixture' })).status, 200);
  assert.match((await publicRequest(f.mcp, '/')).text, /Owner login code/);
  assert.equal((await publicRequest(f.mcp, '/api/status')).status, 401);
  assert.equal((await publicRequest(f.mcp, '/api/bootstrap')).status, 401);
  assert.equal(
    (await publicRequest(f.mcp, '/api/oauth/requests/x/decision', 'POST', { approved: true }))
      .status,
    401,
  );
  const discovery = await publicRequest(f.mcp, '/.well-known/oauth-protected-resource/mcp');
  assert.equal(JSON.parse(discovery.text).resource, 'https://fixture.example/mcp');
  const { body: code } = await f.api('/remote/code', 'POST');
  const badOrigin = await publicRequest(
    f.mcp,
    '/owner/login',
    'POST',
    { code: code.code },
    { origin: 'https://evil.example' },
  );
  assert.equal(badOrigin.status, 403);
  const login = await publicRequest(
    f.mcp,
    '/owner/login',
    'POST',
    { code: code.code },
    { origin: 'https://fixture.example' },
  );
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie']![0], /HttpOnly; Secure; SameSite=Lax/);
  const cookie = login.headers['set-cookie']![0].split(';')[0];
  assert.equal(
    (await publicRequest(f.mcp, '/owner/login', 'POST', { code: code.code })).status,
    401,
  );
  const headers = { cookie, origin: 'https://fixture.example' };
  assert.match((await publicRequest(f.mcp, '/', 'GET', undefined, headers)).text, /id="app"/);
  const bootstrap = await publicRequest(f.mcp, '/api/bootstrap', 'GET', undefined, headers);
  const csrf = JSON.parse(bootstrap.text).csrf;
  assert.equal(
    (
      await publicRequest(f.mcp, '/api/status', 'GET', undefined, {
        ...headers,
        'x-mcp-code-csrf': csrf,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await publicRequest(
        f.mcp,
        '/api/remote/code',
        'POST',
        {},
        { ...headers, 'x-mcp-code-csrf': csrf },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await publicRequest(
        f.mcp,
        '/api/workspaces/' + f.workspaces[0].id,
        'PATCH',
        { name: 'Renamed remotely' },
        { ...headers, 'x-mcp-code-csrf': csrf },
      )
    ).status,
    200,
  );
  await f.api('/mcp', 'POST', { enabled: false });
  assert.equal(
    (
      await publicRequest(f.mcp, '/api/status', 'GET', undefined, {
        ...headers,
        'x-mcp-code-csrf': csrf,
      })
    ).status,
    200,
  );
  assert.equal((await publicRequest(f.mcp, '/mcp', 'POST', {}, headers)).status, 503);
  assert.equal(
    (
      await publicRequest(
        f.mcp,
        '/api/mcp',
        'POST',
        { enabled: true },
        { ...headers, 'x-mcp-code-csrf': csrf },
      )
    ).status,
    200,
  );
  // Owner cookies never authorize an agent's MCP request.
  assert.equal((await publicRequest(f.mcp, '/mcp', 'POST', {}, headers)).status, 401);
  const client = await f.register();
  const authorization = await f.authorize(client, 'https://fixture.example/mcp');
  assert.equal(new URL(authorization.headers.get('location')!).origin, 'https://fixture.example');
  await publicRequest(f.mcp, '/owner/logout', 'POST', undefined, headers);
  assert.equal(
    (
      await publicRequest(f.mcp, '/api/status', 'GET', undefined, {
        ...headers,
        'x-mcp-code-csrf': csrf,
      })
    ).status,
    401,
  );
});

test('workspace switches preserve OAuth jobs; removal narrows grants independent of selection order', async (t) => {
  const f = await fixture(t);
  const [alpha, beta, other] = f.workspaces;
  for (const workspace of [alpha, beta])
    await f.api(`/workspaces/${workspace.id}`, 'PATCH', { approvalMode: 'ask' });
  const grant = async (ids: string[]) => {
    const client = await f.register();
    const authorization = await f.authorize(client);
    const id = new URL(authorization.headers.get('location')!).hash.slice('#oauth='.length);
    const decision = await f.api(`/oauth/requests/${id}/decision`, 'POST', {
      approved: true,
      workspaceIds: ids,
    });
    const issued = await f.token(client, {
      grant_type: 'authorization_code',
      code: new URL(decision.body.redirectUrl).searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: client.redirect_uris[0],
      resource: f.mcp + '/mcp',
    });
    assert.equal(issued.status, 200);
    return { client, ...issued.body };
  };
  const grants = [await grant([alpha.id, beta.id]), await grant([beta.id, alpha.id])];
  const manual = (
    await f.api('/tokens', 'POST', {
      name: 'Manual lifecycle',
      workspaceId: alpha.id,
      permissions: alpha.permissions,
    })
  ).body;
  const manualJob = (
    await f.bridge(manual.token, 'terminal_execute', { command: 'pwd', background: true })
  ).body.structuredContent;
  const oauthJobs = [];
  for (const grant of grants) {
    const job = (
      await f.bridge(grant.access_token, 'terminal_execute', {
        workspaceId: beta.id,
        command: 'pwd',
        background: true,
      })
    ).body.structuredContent;
    assert.equal(job.status, 'awaiting-approval');
    oauthJobs.push(job);
  }
  await f.api(`/workspaces/${other.id}/activate`, 'POST');
  const jobs = (await f.api('/status')).body.jobs;
  assert.equal(jobs.find((job: any) => job.id === manualJob.id).status, 'denied');
  for (const job of oauthJobs)
    assert.equal(jobs.find((value: any) => value.id === job.id).status, 'awaiting-approval');
  await f.api(`/workspaces/${alpha.id}`, 'DELETE');
  for (const grant of grants) {
    const info = await f.bridge(grant.access_token, 'list_workspaces');
    assert.deepEqual(
      info.body.structuredContent.workspaces.map((w: any) => w.id),
      [beta.id],
    );
    assert.equal(
      (await f.bridge(grant.access_token, 'workspace_info')).body.structuredContent.id,
      beta.id,
    );
    assert.equal(
      (await f.bridge(grant.access_token, 'workspace_info', { workspaceId: alpha.id })).body
        .isError,
      true,
    );
    const renewed = await f.token(grant.client, {
      grant_type: 'refresh_token',
      refresh_token: grant.refresh_token,
      resource: f.mcp + '/mcp',
    });
    assert.equal(renewed.status, 200);
    Object.assign(grant, renewed.body);
  }
  for (const job of oauthJobs)
    assert.equal(
      (await f.api('/status')).body.jobs.find((value: any) => value.id === job.id).status,
      'awaiting-approval',
    );
  await f.api(`/workspaces/${beta.id}`, 'DELETE');
  for (const grant of grants) {
    assert.equal((await f.bridge(grant.access_token, 'workspace_info')).status, 401);
    assert.equal(
      (
        await f.token(grant.client, {
          grant_type: 'refresh_token',
          refresh_token: grant.refresh_token,
          resource: f.mcp + '/mcp',
        })
      ).body.error,
      'invalid_grant',
    );
  }
  for (const job of oauthJobs)
    assert.equal(
      (await f.api('/status')).body.jobs.find((value: any) => value.id === job.id).status,
      'denied',
    );
  const saved = await new JsonStore(f.config).load();
  for (const record of saved.state.tokens.filter((token) => token.oauth)) {
    assert.deepEqual(record.oauth!.workspaceIds, []);
    assert.deepEqual(record.oauth!.workspacePermissions, {});
    assert.ok(record.revokedAt);
  }
});

test('resource limits persist and reject invalid settings; OAuth client removal invalidates grants and pending approvals', async (t) => {
  const f = await fixture(t);
  const workspace = f.workspaces[0];
  const resources = { memoryMb: 2048, cpus: 2, timeoutSeconds: 600 };
  assert.equal(
    (await f.api(`/workspaces/${workspace.id}`, 'PATCH', { resources, approvalMode: 'ask' }))
      .status,
    200,
  );
  for (const bad of [
    { ...resources, memoryMb: 0 },
    { ...resources, cpus: 100 },
    { ...resources, timeoutSeconds: 3601 },
  ])
    assert.equal(
      (await f.api(`/workspaces/${workspace.id}`, 'PATCH', { resources: bad })).status,
      400,
    );
  const client = await f.register('client_secret_post');
  const auth = await f.authorize(client);
  const id = new URL(auth.headers.get('location')!).hash.slice('#oauth='.length);
  const decision = await f.api(`/oauth/requests/${id}/decision`, 'POST', {
    approved: true,
    workspaceIds: [workspace.id],
  });
  const issued = await f.token(client, {
    grant_type: 'authorization_code',
    code: new URL(decision.body.redirectUrl).searchParams.get('code')!,
    code_verifier: verifier,
    redirect_uri: client.redirect_uris[0],
    resource: f.mcp + '/mcp',
  });
  assert.equal(issued.status, 200);
  await f.bridge(issued.body.access_token, 'terminal_execute', {
    command: 'pwd',
    background: true,
  });
  await f.authorize(client);
  const before = (await f.api('/status')).body;
  assert.equal(before.oauthClients.length, 1);
  assert.ok(!JSON.stringify(before.oauthClients).includes('secret'));
  assert.equal((await f.api(`/oauth/clients/${client.client_id}`, 'DELETE')).status, 200);
  const after = (await f.api('/status')).body;
  assert.equal(after.oauthClients.length, 0);
  assert.equal(after.oauthRequests.length, 0);
  assert.ok(after.jobs.every((j: any) => !['running', 'awaiting-approval'].includes(j.status)));
  assert.equal((await f.bridge(issued.body.access_token, 'list_workspaces')).status, 401);
  assert.notEqual(
    (
      await f.token(client, {
        grant_type: 'refresh_token',
        refresh_token: issued.body.refresh_token,
        resource: f.mcp + '/mcp',
      })
    ).status,
    200,
  );
  await f.restart();
  assert.deepEqual((await f.api('/status')).body.workspaces[0].resources, resources);
  assert.equal((await f.api('/status')).body.oauthClients.length, 0);
});

test('sign out all invalidates every owner session and unused login codes', async (t) => {
  const f = await fixture(t);
  await f.api('/tunnels/start', 'POST', { provider: 'fixture' });
  const cookies: string[] = [];
  for (let i = 0; i < 2; i++) {
    const code = (await f.api('/remote/code', 'POST')).body.code;
    const login = await publicRequest(
      f.mcp,
      '/owner/login',
      'POST',
      { code },
      { origin: 'https://fixture.example' },
    );
    assert.equal(login.status, 200);
    cookies.push(login.headers['set-cookie']![0].split(';')[0]);
  }
  const unused = (await f.api('/remote/code', 'POST')).body.code;
  assert.equal((await fetch(f.base + '/api/remote/logout-all', { method: 'POST' })).status, 403);
  assert.equal((await f.api('/remote/logout-all', 'POST')).status, 200);
  for (const cookie of cookies)
    assert.equal(
      (await publicRequest(f.mcp, '/api/bootstrap', 'GET', undefined, { cookie })).status,
      401,
    );
  assert.equal(
    (
      await publicRequest(
        f.mcp,
        '/owner/login',
        'POST',
        { code: unused },
        { origin: 'https://fixture.example' },
      )
    ).status,
    401,
  );
});

test('saved tunnel configuration persists, requires owner CSRF, and rejects changes during a connection', async (t) => {
  const f = await fixture(t);
  const config = { mode: 'ngrok-domain', publicUrl: 'https://mcp.example.com' };
  assert.equal(
    (
      await fetch(f.base + '/api/tunnels/config/ngrok', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
      })
    ).status,
    403,
  );
  assert.equal((await f.api('/tunnels/config/ngrok', 'PUT', config)).status, 200);
  assert.equal(
    (await f.api('/tunnels/config/ngrok', 'PUT', { ...config, publicUrl: 'http://bad.example' }))
      .status,
    400,
  );
  await f.restart();
  assert.deepEqual((await f.api('/status')).body.tunnelConfigs.ngrok, config);
  await f.api('/tunnels/start', 'POST', { provider: 'fixture' });
  assert.equal((await f.api('/tunnels/config/ngrok', 'PUT', { mode: 'temporary' })).status, 409);
  const checks = await f.api('/diagnostics');
  assert.equal(checks.status, 200);
  assert.ok(checks.body.providers.some((p: any) => p.id === 'fixture' && p.ready));
});
