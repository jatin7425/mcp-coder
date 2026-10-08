import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { JsonStore } from '../config/store.js';
import { acquireLease, type DaemonInfo } from '../config/lease.js';
import { WorkspaceManager, nativeFolderPicker, validateWorkspace } from '../workspace/manager.js';
import { InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { WorkspaceOAuthProvider } from '../authentication/oauth.js';
import { TokenManager } from '../authentication/tokens.js';
import { AuditLogger } from '../audit/store.js';
import { DockerSandbox } from '../sandbox/docker.js';
import { TerminalManager } from '../terminal/manager.js';
import { RemoteDashboard } from './remote-dashboard.js';
import { TunnelManager } from '../tunnel-manager/manager.js';
import { ToolService, type ToolName, toolSchemas } from '../mcp-server/tools.js';
import { serveMcp } from '../mcp-server/server.js';
import { AppError, message, type Principal, type Permissions } from '../shared/types.js';
const permissionsSchema = z
  .object({
    read: z.boolean(),
    write: z.boolean(),
    execute: z.boolean(),
    git: z.boolean(),
    network: z.boolean(),
  })
  .strict();
const wrap =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
function listen(app: express.Express, port: number) {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}
function close(server?: Server) {
  return new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
export function localHostAllowed(host: string | undefined, port: number) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
export function localOriginAllowed(origin: string | undefined, port: number) {
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}
export interface Runtime {
  info: DaemonInfo;
  stop(): Promise<void>;
  store: JsonStore;
  terminals: TerminalManager;
}
export async function startRuntime(
  directory: string,
  options: { tunnels?: TunnelManager } = {},
): Promise<Runtime> {
  const release = await acquireLease(directory);
  let uiServer: Server | undefined, mcpServer: Server | undefined;
  let terminals: TerminalManager | undefined;
  let sandbox: DockerSandbox | undefined;
  const tunnels = options.tunnels || new TunnelManager();
  try {
    const store = await new JsonStore(directory).load();
    const { uiPort, mcpPort } = store.state.settings;
    if (
      !Number.isInteger(uiPort) ||
      !Number.isInteger(mcpPort) ||
      uiPort < 1024 ||
      mcpPort < 1024 ||
      uiPort > 65535 ||
      mcpPort > 65535 ||
      uiPort === mcpPort
    )
      throw new Error('Invalid UI/MCP ports in local state.');
    const info: DaemonInfo = {
      pid: process.pid,
      uiPort,
      mcpPort,
      instance: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    const workspaces = new WorkspaceManager(store, directory);
    const tokens = new TokenManager(store);
    const audit = new AuditLogger(store);
    audit.prune();
    sandbox = new DockerSandbox(directory);
    await sandbox.recover();
    const docker = sandbox;
    terminals = new TerminalManager(docker, workspaces, tokens, audit);
    const terminal = terminals;
    const tools = new ToolService(terminal, workspaces, audit);
    let mcpEnabled = true,
      stopping = false;
    const oauthResource = () =>
      `${tunnels.status().publicUrl || `http://127.0.0.1:${mcpPort}`}/mcp`;
    const oauth = new WorkspaceOAuthProvider(
      store,
      tokens,
      oauthResource,
      () => tunnels.status().publicUrl || `http://127.0.0.1:${uiPort}`,
      (id) => terminal.cancelWhere((job) => job.tokenId === id),
    );
    const csrf = randomBytes(32).toString('base64url');
    const clients = new Map<string, { name: string; workspaceId: string; lastSeen: string }>();
    const rate = new Map<string, { count: number; start: number }>();
    let cachedSandbox: Awaited<ReturnType<DockerSandbox['availability']>> | undefined,
      lastCheck = 0;
    const ui = express();
    ui.disable('x-powered-by');
    ui.use((req, res, next) => {
      if (
        !localHostAllowed(req.headers.host, uiPort) ||
        !localOriginAllowed(req.headers.origin, uiPort)
      )
        return res.status(403).json({ error: 'Local dashboard access only.' });
      res.set({
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      });
      next();
    });
    ui.get('/api/health', (_req, res) =>
      res.json({ name: 'mcp-code', instance: info.instance, stopping }),
    );
    ui.get('/api/bootstrap', (_req, res) => res.json({ csrf }));
    ui.use('/api', (req, res, next) => {
      if (req.headers['x-mcp-code-csrf'] !== csrf)
        return res
          .status(403)
          .json({ error: 'Reload the dashboard to establish a local session.' });
      if (stopping) return res.status(503).json({ error: 'Runtime is shutting down.' });
      next();
    });
    ui.use(express.json({ limit: '32kb' }));
    ui.use('/api/workspaces', (req, res, next) => {
      if (req.method !== 'GET' && req.path !== '/pick') {
        const resume = terminal.suspend();
        res.once('finish', resume);
        res.once('close', resume);
      }
      next();
    });
    ui.get(
      '/api/status',
      wrap(async (_req, res) => {
        if (!cachedSandbox || Date.now() - lastCheck > 5000) {
          cachedSandbox = await docker.availability();
          lastCheck = Date.now();
        }
        for (const [id, client] of clients)
          if (Date.now() - Date.parse(client.lastSeen) > 120_000 || !tokens.valid(id))
            clients.delete(id);
        res.json({
          runtime: { ...info, mcpEnabled },
          workspaces: workspaces.list(),
          activeWorkspaceId: store.state.activeWorkspaceId,
          tokens: tokens.publicRecords(),
          oauthRequests: oauth.requests(),
          sandbox: cachedSandbox,
          imageBuild: docker.buildStatus,
          tunnel: tunnels.status(),
          jobs: terminal.list(),
          activity: [...store.state.audit].reverse(),
          clients: [...clients.entries()].map(([id, client]) => ({ id, ...client })),
          settings: store.state.settings,
        });
      }),
    );
    ui.post(
      '/api/oauth/requests/:id/decision',
      wrap(async (req, res) => {
        const { approved, workspaceIds } = z
          .object({
            approved: z.boolean(),
            workspaceIds: z.array(z.string().uuid()).max(100).default([]),
          })
          .strict()
          .parse(req.body);
        res.json(await oauth.decide(String(req.params.id), approved, workspaceIds));
      }),
    );
    ui.post(
      '/api/workspaces/pick',
      wrap(async (_req, res) => {
        res.json({ path: await nativeFolderPicker() });
      }),
    );
    ui.post(
      '/api/workspaces',
      wrap(async (req, res) => {
        const input = z
          .object({ path: z.string().min(1).max(4096), name: z.string().max(80).optional() })
          .parse(req.body);
        res.status(201).json(await workspaces.add(input.path, input.name));
      }),
    );
    ui.post(
      '/api/workspaces/:id/activate',
      wrap(async (req, res) => {
        const workspace = workspaces.get(String(req.params.id));
        await validateWorkspace(workspace.path, directory);
        store.state.activeWorkspaceId = undefined;
        await terminal.cancelWhere(
          (job) => !store.state.tokens.find((token) => token.id === job.tokenId)?.oauth,
        );
        store.state.activeWorkspaceId = workspace.id;
        for (const id of clients.keys()) if (!tokens.valid(id)) clients.delete(id);
        await store.save();
        res.json({ ok: true });
      }),
    );
    ui.patch(
      '/api/workspaces/:id',
      wrap(async (req, res) => {
        const input = z
          .object({
            permissions: permissionsSchema.optional(),
            approvalMode: z.enum(['autonomous', 'ask']).optional(),
            name: z.string().min(1).max(80).optional(),
          })
          .strict()
          .parse(req.body);
        const workspace = workspaces.get(String(req.params.id));
        // Revoke current execution before updating policy; no stale container keeps broader rights.
        Object.assign(workspace, input);
        await terminal.cancelWhere((job) => job.workspaceId === workspace.id);
        await store.save();
        res.json(workspace);
      }),
    );
    ui.delete(
      '/api/workspaces/:id',
      wrap(async (req, res) => {
        const id = String(req.params.id);
        workspaces.get(id);
        if (store.state.activeWorkspaceId === id) store.state.activeWorkspaceId = undefined;
        await terminal.cancelWhere((job) => job.workspaceId === id);
        store.state.workspaces = workspaces.list().filter((w) => w.id !== id);
        // Remove only this workspace from OAuth grants, regardless of selection order.
        // Grants keep their original permission ceilings for every surviving workspace.
        for (const token of store.state.tokens) {
          if (token.oauth?.workspaceIds.includes(id)) {
            token.oauth.workspaceIds = token.oauth.workspaceIds.filter(
              (workspaceId) => workspaceId !== id,
            );
            delete token.oauth.workspacePermissions[id];
            if (token.oauth.workspaceIds.length) {
              token.workspaceId = token.oauth.workspaceIds[0];
              token.permissions = { ...token.oauth.workspacePermissions[token.workspaceId] };
            } else token.revokedAt = new Date().toISOString();
          } else if (!token.oauth && token.workspaceId === id)
            token.revokedAt = new Date().toISOString();
        }
        for (const clientId of clients.keys())
          if (!tokens.valid(clientId)) clients.delete(clientId);
        await store.save();
        res.json({ ok: true });
      }),
    );
    ui.post(
      '/api/tokens',
      wrap(async (req, res) => {
        const input = z
          .object({
            name: z.string().trim().min(1).max(80),
            workspaceId: z.string().uuid(),
            permissions: permissionsSchema,
            expiresInHours: z.number().min(0.01).max(8760).optional(),
          })
          .parse(req.body);
        workspaces.get(input.workspaceId);
        if (store.state.tokens.filter((t) => !t.revokedAt).length >= 100)
          throw new AppError('Revoke existing tokens before creating more.', 429);
        res
          .status(201)
          .json(
            await tokens.create(
              input.name,
              input.workspaceId,
              input.permissions as Permissions,
              input.expiresInHours,
            ),
          );
      }),
    );
    ui.post(
      '/api/tokens/:id/revoke',
      wrap(async (req, res) => {
        const id = String(req.params.id);
        await tokens.revoke(id);
        await terminal.cancelWhere((j) => j.tokenId === id);
        clients.delete(id);
        res.json({ ok: true });
      }),
    );
    ui.post(
      '/api/tokens/:id/rotate',
      wrap(async (req, res) => {
        const previous = store.state.tokens.find((t) => t.id === String(req.params.id));
        if (!previous) throw new AppError('Token not found.', 404);
        if (previous.oauth)
          throw new AppError(
            'OAuth connections renew through their client. Revoke and authorize again to change workspaces.',
          );
        await tokens.revoke(previous.id);
        await terminal.cancelWhere((j) => j.tokenId === previous.id);
        clients.delete(previous.id);
        const hours = previous.expiresAt
          ? Math.max(0.01, (Date.parse(previous.expiresAt) - Date.now()) / 3600000)
          : undefined;
        res.json(
          await tokens.create(previous.name, previous.workspaceId, previous.permissions, hours),
        );
      }),
    );
    ui.post(
      '/api/tokens/revoke-all',
      wrap(async (_req, res) => {
        for (const record of store.state.tokens) record.revokedAt = new Date().toISOString();
        await store.save();
        await terminal.cancelWhere(() => true);
        clients.clear();
        res.json({ ok: true });
      }),
    );
    ui.post(
      '/api/jobs/:id/cancel',
      wrap(async (req, res) => {
        await terminal.cancel(String(req.params.id));
        res.json({ ok: true });
      }),
    );
    ui.post(
      '/api/jobs/:id/approval',
      wrap(async (req, res) => {
        const input = z.object({ approved: z.boolean() }).parse(req.body);
        await terminal.approve(String(req.params.id), input.approved);
        res.json({ ok: true });
      }),
    );
    ui.post('/api/sandbox/build', (_req, res) => {
      docker.startBuild();
      cachedSandbox = undefined;
      res.status(202).json({ ok: true });
    });
    ui.get(
      '/api/tunnels/providers',
      wrap(async (_req, res) => {
        res.json(await tunnels.availability());
      }),
    );
    ui.post(
      '/api/tunnels/start',
      wrap(async (req, res) => {
        const { provider } = z.object({ provider: z.string() }).parse(req.body);
        res.json(await tunnels.start(provider, mcpPort));
      }),
    );
    ui.post(
      '/api/tunnels/stop',
      wrap(async (_req, res) => {
        remoteDashboard.clear();
        await tunnels.stop();
        res.json({ ok: true });
      }),
    );
    ui.post(
      '/api/mcp',
      wrap(async (req, res) => {
        const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
        mcpEnabled = enabled;
        if (!enabled) {
          await terminal.cancelWhere(() => true);
          clients.clear();
        }
        res.json({ ok: true });
      }),
    );
    ui.delete(
      '/api/activity',
      wrap(async (_req, res) => {
        await audit.clear();
        res.json({ ok: true });
      }),
    );
    ui.patch(
      '/api/settings',
      wrap(async (req, res) => {
        const settings = z
          .object({
            uiPort: z.number().int().min(1024).max(65535),
            mcpPort: z.number().int().min(1024).max(65535),
            retentionDays: z.number().int().min(1).max(90),
          })
          .parse(req.body);
        if (settings.uiPort === settings.mcpPort)
          throw new AppError('Dashboard and MCP ports must differ.');
        store.state.settings = settings;
        audit.prune();
        await store.save();
        res.json({
          ok: true,
          restartRequired: settings.uiPort !== uiPort || settings.mcpPort !== mcpPort,
        });
      }),
    );
    const sourceWeb = fileURLToPath(new URL('../../apps/web/', import.meta.url));
    const packagedWeb = fileURLToPath(new URL('../../../apps/web/', import.meta.url));
    const web = import.meta.url.includes('/dist/packages/') ? packagedWeb : sourceWeb;
    const remoteDashboard = new RemoteDashboard(uiPort, () => tunnels.status().publicUrl, web);
    ui.post('/api/remote/code', (_req, res, next) => {
      try {
        res.json(remoteDashboard.createCode());
      } catch (error) {
        next(error);
      }
    });
    ui.use(express.static(web));
    ui.get('/', (_req, res) => res.sendFile(join(web, 'index.html')));
    const mcp = express();
    mcp.disable('x-powered-by');
    mcp.use((req, res, next) => {
      res.set({
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      });
      const publicUrl = tunnels.status().publicUrl;
      const remoteHost = publicUrl ? new URL(publicUrl).host : undefined;
      if (!localHostAllowed(req.headers.host, mcpPort) && req.headers.host !== remoteHost)
        return res.status(403).json({ error: 'Invalid endpoint host.' });
      const authEndpoint =
        /^\/(authorize|token|register|revoke)(\/|$)/.test(req.path) ||
        req.path.startsWith('/.well-known/');
      if (
        !authEndpoint &&
        req.headers.origin &&
        !localOriginAllowed(req.headers.origin, mcpPort) &&
        req.headers.origin !== publicUrl
      )
        return res.status(403).json({ error: 'Origin is not allowed.' });
      if (stopping) return res.status(503).json({ error: 'Runtime is shutting down.' });
      next();
    });
    mcp.use(remoteDashboard.router());
    mcp.use((_req, res, next) =>
      mcpEnabled ? next() : res.status(503).json({ error: 'MCP is stopped.' }),
    );
    mcp.use(express.json({ limit: '64kb' }));
    mcp.use(
      ['/token', '/revoke'],
      express.urlencoded({ extended: false, limit: '16kb' }),
      oauth.credentialGuard,
    );
    mcp.use('/token', (req, res, next) => {
      if (
        req.method === 'POST' &&
        req.body?.grant_type === 'authorization_code' &&
        (typeof req.body.code_verifier !== 'string' ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(req.body.code_verifier))
      )
        return res
          .status(400)
          .json(new InvalidRequestError('A valid PKCE verifier is required.').toResponseObject());
      next();
    });
    // Bound public OAuth traffic across this local runtime. Do not trust forwarded IP
    // headers supplied through arbitrary tunnel providers or by clients.
    const oauthRateLimit = { keyGenerator: () => 'mcp-code-instance' };
    // Initialize rate-limited SDK handlers once. Only metadata depends on the active tunnel URL.
    mcp.use('/authorize', authorizationHandler({ provider: oauth, rateLimit: oauthRateLimit }));
    mcp.use('/token', tokenHandler({ provider: oauth, rateLimit: oauthRateLimit }));
    mcp.use(
      '/register',
      clientRegistrationHandler({ clientsStore: oauth.clientsStore, rateLimit: oauthRateLimit }),
    );
    mcp.use('/revoke', revocationHandler({ provider: oauth, rateLimit: oauthRateLimit }));
    mcp.get('/.well-known/oauth-authorization-server', (_req, res) => {
      res.set('Access-Control-Allow-Origin', '*');
      res.json(
        createOAuthMetadata({
          provider: oauth,
          issuerUrl: new URL(new URL(oauthResource()).origin),
          scopesSupported: ['mcp:access'],
        }),
      );
    });
    mcp.get(
      ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
      (_req, res) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.json({
          resource: oauthResource(),
          authorization_servers: [new URL(oauthResource()).origin + '/'],
          scopes_supported: ['mcp:access'],
          resource_name: 'MCP Code workspaces',
        });
      },
    );
    mcp.use((req, res, next) => {
      try {
        const auth = req.headers.authorization;
        if (!auth?.startsWith('Bearer '))
          throw new AppError('Bearer access token is required.', 401);
        const principal = tokens.verify(auth.slice(7), oauthResource());
        let bucket = rate.get(principal.tokenId);
        if (!bucket || Date.now() - bucket.start > 60_000) {
          bucket = { count: 0, start: Date.now() };
          rate.set(principal.tokenId, bucket);
        }
        if (++bucket.count > 120)
          throw new AppError('Request limit reached. Retry in a minute.', 429);
        if (rate.size > 200)
          for (const [id, value] of rate) if (Date.now() - value.start > 60_000) rate.delete(id);
        res.locals.principal = principal;
        clients.set(principal.tokenId, {
          name: principal.name,
          workspaceId: principal.workspaceId,
          lastSeen: new Date().toISOString(),
        });
        next();
      } catch (error) {
        const status = error instanceof AppError ? error.status : 401;
        if (status === 401)
          res.set(
            'WWW-Authenticate',
            `Bearer realm="mcp-code", resource_metadata="${new URL(oauthResource()).origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:access"`,
          );
        res.status(status).json({ error: message(error) });
      }
    });
    mcp.use(express.json({ limit: '64kb' }));
    mcp.post(
      '/mcp',
      wrap(async (req, res) => {
        await serveMcp(req, res, tools, res.locals.principal as Principal);
      }),
    );
    // Separate local stdio proxy bridge; protected by the same bearer token and policy.
    mcp.post(
      '/bridge/:tool',
      wrap(async (req, res) => {
        const name = String(req.params.tool) as ToolName;
        if (!Object.hasOwn(toolSchemas, name)) throw new AppError('Unknown tool.', 404);
        const controller = new AbortController();
        res.once('close', () => {
          if (!res.writableEnded) controller.abort();
        });
        res.json(
          await tools.result(name, req.body, res.locals.principal as Principal, controller.signal),
        );
      }),
    );
    mcp.all('/mcp', (_req, res) =>
      res
        .status(405)
        .set('Allow', 'POST')
        .json({ error: 'This stateless MCP endpoint supports POST.' }),
    );
    const errorHandler = (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (res.headersSent) return;
      const bodyError = error as { type?: string };
      const status =
        error instanceof AppError
          ? error.status
          : error instanceof ZodError || bodyError.type === 'entity.parse.failed'
            ? 400
            : bodyError.type === 'entity.too.large'
              ? 413
              : 500;
      res.status(status).json({
        error:
          error instanceof ZodError
            ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
            : status === 500
              ? 'Operation failed. Check the local runtime log.'
              : message(error),
      });
      if (status === 500) console.error(message(error));
    };
    ui.use(errorHandler);
    mcp.use(errorHandler);
    uiServer = await listen(ui, uiPort);
    mcpServer = await listen(mcp, mcpPort);
    await writeFile(join(directory, 'daemon.json'), JSON.stringify(info), { mode: 0o600 });
    let shutdown: Promise<void> | undefined;
    const stop = () =>
      (shutdown ||= (async () => {
        stopping = true;
        mcpEnabled = false;
        await terminal.stop();
        remoteDashboard.clear();
        await tunnels.stop();
        await close(mcpServer);
        await close(uiServer);
        try {
          await store.save();
        } finally {
          await release();
        }
      })());
    ui.post('/api/shutdown', (_req, res) => {
      res.json({ ok: true });
      setTimeout(() => {
        void stop().then(() => {
          if (process.env.MCP_CODE_DAEMON_CHILD === '1') process.exit(0);
        });
      }, 50);
    });
    return { info, stop, store, terminals: terminal };
  } catch (error) {
    await terminals?.stop().catch(() => {});
    await sandbox?.stopAll().catch(() => {});
    await tunnels.stop().catch(() => {});
    await close(mcpServer);
    await close(uiServer);
    await release();
    throw error;
  }
}
