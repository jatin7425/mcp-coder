import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidClientError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidRequestError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { ConfigStore } from '../config/store.js';
import {
  AppError,
  type OAuthClientRecord,
  type Permissions,
  type TokenRecord,
} from '../shared/types.js';
import { TokenManager, tokenHash } from './tokens.js';

const secret = () => randomBytes(32).toString('base64url');
const seconds = () => Math.floor(Date.now() / 1000);
interface PendingConsent {
  id: string;
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  resource: string;
  expiresAt: number;
}
interface ApprovedCode extends PendingConsent {
  workspaceIds: string[];
  workspacePermissions: Record<string, Permissions>;
}
export class WorkspaceOAuthProvider implements OAuthServerProvider {
  private pending = new Map<string, PendingConsent>();
  private codes = new Map<string, ApprovedCode>();
  readonly clientsStore;
  constructor(
    private store: ConfigStore,
    private tokens: TokenManager,
    readonly resource: () => string,
    private uiBase: () => string,
    private cancelToken: (id: string) => Promise<void>,
  ) {
    store.state.oauthClients ||= [];
    this.clientsStore = {
      getClient: (id: string): OAuthClientInformationFull | undefined => {
        const record = this.store.state.oauthClients!.find((c) => c.client_id === id);
        if (!record) return undefined;
        const { secretHash: _hash, ...client } = record;
        // SDK handlers see public metadata. credentialGuard verifies confidential clients
        // against a hash before the token/revocation handlers run.
        return client;
      },
      registerClient: async (
        input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
      ): Promise<OAuthClientInformationFull> => {
        if (this.store.state.oauthClients!.length >= 100)
          throw new InvalidClientMetadataError('Client registration limit reached.');
        const method = input.token_endpoint_auth_method || 'client_secret_post';
        if (!['none', 'client_secret_post'].includes(method))
          throw new InvalidClientMetadataError('Use none or client_secret_post authentication.');
        if (
          !input.redirect_uris.length ||
          input.redirect_uris.length > 10 ||
          input.redirect_uris.some((uri) => !safeRedirect(uri))
        )
          throw new InvalidClientMetadataError(
            'Redirects must be HTTPS or HTTP loopback URLs, without credentials or fragments.',
          );
        if (
          (input.client_name?.length || 0) > 80 ||
          input.grant_types?.some((t) => !['authorization_code', 'refresh_token'].includes(t)) ||
          input.response_types?.some((t) => t !== 'code')
        )
          throw new InvalidClientMetadataError('Unsupported client metadata.');
        const rawSecret =
          method === 'client_secret_post' ? input.client_secret || secret() : undefined;
        const record: OAuthClientRecord = {
          client_id: randomUUID(),
          client_id_issued_at: seconds(),
          client_name: input.client_name || 'MCP agent',
          redirect_uris: input.redirect_uris,
          token_endpoint_auth_method: method as 'none' | 'client_secret_post',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          ...(rawSecret
            ? { secretHash: tokenHash(rawSecret), client_secret_expires_at: seconds() + 30 * 86400 }
            : {}),
        };
        this.store.state.oauthClients!.push(record);
        await this.store.save();
        const { secretHash: _hash, ...client } = record;
        return { ...client, ...(rawSecret ? { client_secret: rawSecret } : {}) };
      },
    };
  }
  publicClients() {
    return this.store.state.oauthClients!.map(({ client_id, client_name, redirect_uris }) => ({
      client_id,
      client_name,
      redirect_uris,
    }));
  }
  async removeClient(id: string) {
    if (!this.store.state.oauthClients!.some((c) => c.client_id === id))
      throw new AppError('OAuth client not found.', 404);
    this.store.state.oauthClients = this.store.state.oauthClients!.filter(
      (c) => c.client_id !== id,
    );
    for (const [key, request] of this.pending)
      if (request.client.client_id === id) this.pending.delete(key);
    for (const [key, code] of this.codes) if (code.client.client_id === id) this.codes.delete(key);
    const affected = this.store.state.tokens.filter((t) => t.oauth?.clientId === id);
    for (const token of affected) token.revokedAt = new Date().toISOString();
    await this.store.save();
    await Promise.all(affected.map((token) => this.cancelToken(token.id)));
  }
  credentialGuard: RequestHandler = (req, res, next) => {
    if (req.method !== 'POST') return next();
    const client = this.store.state.oauthClients!.find((c) => c.client_id === req.body?.client_id);
    if (client?.secretHash) {
      const supplied = req.body?.client_secret;
      if (
        typeof supplied !== 'string' ||
        supplied.length > 1024 ||
        !timingSafeEqual(
          Buffer.from(tokenHash(supplied), 'hex'),
          Buffer.from(client.secretHash, 'hex'),
        ) ||
        (client.client_secret_expires_at && client.client_secret_expires_at <= seconds())
      ) {
        return res
          .status(401)
          .json(new InvalidClientError('Invalid client credentials.').toResponseObject());
      }
    }
    next();
  };
  private prune() {
    for (const map of [this.pending, this.codes])
      for (const [id, item] of map) if (item.expiresAt <= Date.now()) map.delete(id);
  }
  private checkResource(resource?: URL, expected = this.resource()) {
    if (!resource || resource.href !== expected || expected !== this.resource())
      throw new InvalidTargetError('resource must match the current MCP endpoint exactly.');
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.checkResource(params.resource);
    if ((params.scopes || []).some((scope) => scope !== 'mcp:access'))
      throw new InvalidScopeError('Only mcp:access is supported.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
      throw new InvalidRequestError('A SHA-256 PKCE challenge is required.');
    this.prune();
    if (this.pending.size >= 100) throw new InvalidRequestError('Too many pending approvals.');
    const id = secret();
    this.pending.set(id, {
      id,
      client,
      params,
      resource: this.resource(),
      expiresAt: Date.now() + 300_000,
    });
    res.redirect(302, `${this.uiBase()}/#oauth=${id}`);
  }
  requests() {
    this.prune();
    return [...this.pending.values()].map(({ id, client, params, resource, expiresAt }) => ({
      id,
      clientName: client.client_name || 'MCP agent',
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      resource,
      expiresAt: new Date(expiresAt).toISOString(),
    }));
  }
  async decide(id: string, approved: boolean, workspaceIds: string[]) {
    this.prune();
    const pending = this.pending.get(id);
    if (!pending) throw new AppError('Authorization request expired or was already reviewed.', 404);
    if (pending.resource !== this.resource())
      throw new AppError('Connection changed. Start authorization again.', 409);
    const ids = [...new Set(workspaceIds)];
    const workspacePermissions: Record<string, Permissions> = {};
    if (approved) {
      if (!ids.length) throw new AppError('Select at least one workspace.');
      for (const id of ids) {
        const workspace = this.store.state.workspaces.find((w) => w.id === id);
        if (!workspace || !workspace.permissions.read)
          throw new AppError('Workspace is unavailable or read access is disabled.');
        workspacePermissions[id] = { ...workspace.permissions };
      }
    }
    this.pending.delete(id);
    const redirect = new URL(pending.params.redirectUri);
    if (pending.params.state !== undefined)
      redirect.searchParams.set('state', pending.params.state);
    if (!approved) redirect.searchParams.set('error', 'access_denied');
    else {
      const code = secret();
      this.codes.set(tokenHash(code), {
        ...pending,
        workspaceIds: ids,
        workspacePermissions,
        expiresAt: Date.now() + 60_000,
      });
      redirect.searchParams.set('code', code);
    }
    return { redirectUrl: redirect.href };
  }
  private code(client: OAuthClientInformationFull, raw: string) {
    this.prune();
    const code = this.codes.get(tokenHash(raw));
    if (!code || code.client.client_id !== client.client_id)
      throw new InvalidGrantError('Invalid or expired authorization code.');
    return code;
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, raw: string) {
    return this.code(client, raw).params.codeChallenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    raw: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = this.code(client, raw);
    this.checkResource(resource, code.resource);
    if (redirectUri !== code.params.redirectUri)
      throw new InvalidGrantError('redirect_uri does not match authorization.');
    if (this.store.state.tokens.filter((t) => !t.revokedAt).length >= 100)
      throw new InvalidGrantError('Revoke existing connections before adding another.');
    if (code.workspaceIds.some((id) => !this.store.state.workspaces.some((w) => w.id === id)))
      throw new InvalidGrantError('An approved workspace was removed. Authorize again.');
    this.codes.delete(tokenHash(raw)); // consume before any asynchronous operation
    const access = 'mcpc_' + secret(),
      refresh = 'mcpr_' + secret();
    const record: TokenRecord = {
      id: randomUUID(),
      name: client.client_name || 'MCP agent',
      hash: tokenHash(access),
      workspaceId: code.workspaceIds[0],
      permissions: { ...code.workspacePermissions[code.workspaceIds[0]] },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      oauth: {
        clientId: client.client_id,
        resource: code.resource,
        workspaceIds: code.workspaceIds,
        workspacePermissions: code.workspacePermissions,
        refreshHash: tokenHash(refresh),
        refreshExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
        previousRefreshHashes: [],
      },
    };
    this.store.state.tokens.push(record);
    await this.store.save();
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp:access',
    };
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    raw: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.checkResource(resource);
    if (scopes?.some((s) => s !== 'mcp:access'))
      throw new InvalidScopeError('Scope cannot be expanded.');
    const hash = tokenHash(raw);
    const replay = this.store.state.tokens.find(
      (t) => t.oauth?.clientId === client.client_id && t.oauth.previousRefreshHashes.includes(hash),
    );
    if (replay) {
      await this.tokens.revoke(replay.id);
      await this.cancelToken(replay.id);
      throw new InvalidGrantError('Refresh token was already used. Authorize again.');
    }
    const record = this.store.state.tokens.find(
      (t) => t.oauth?.clientId === client.client_id && t.oauth.refreshHash === hash,
    );
    if (
      !record?.oauth ||
      record.revokedAt ||
      Date.parse(record.oauth.refreshExpiresAt) <= Date.now() ||
      record.oauth.resource !== resource?.href ||
      !record.oauth.workspaceIds.some((id) => this.store.state.workspaces.some((w) => w.id === id))
    )
      throw new InvalidGrantError('Invalid, expired or revoked refresh token.');
    const access = 'mcpc_' + secret(),
      refresh = 'mcpr_' + secret();
    record.oauth.previousRefreshHashes.push(record.oauth.refreshHash);
    record.oauth.previousRefreshHashes = record.oauth.previousRefreshHashes.slice(-256);
    record.oauth.refreshHash = tokenHash(refresh);
    record.hash = tokenHash(access);
    record.expiresAt = new Date(Date.now() + 3600_000).toISOString();
    await this.store.save();
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp:access',
    };
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const principal = this.tokens.verify(token, this.resource());
    const record = this.store.state.tokens.find((t) => t.id === principal.tokenId)!;
    return {
      token,
      clientId: record.oauth?.clientId || record.id,
      scopes: ['mcp:access'],
      expiresAt: record.expiresAt ? Math.floor(Date.parse(record.expiresAt) / 1000) : undefined,
      resource: new URL(this.resource()),
    };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const hash = tokenHash(request.token);
    const record = this.store.state.tokens.find(
      (t) =>
        t.oauth?.clientId === client.client_id &&
        (t.hash === hash ||
          t.oauth.refreshHash === hash ||
          t.oauth.previousRefreshHashes.includes(hash)),
    );
    if (record) {
      await this.tokens.revoke(record.id);
      await this.cancelToken(record.id);
    }
  }
}
export function safeRedirect(raw: string) {
  if (raw.length > 2048) return false;
  try {
    const url = new URL(raw);
    return (
      !url.hash &&
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
