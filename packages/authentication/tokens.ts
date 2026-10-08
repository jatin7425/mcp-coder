import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ConfigStore } from '../config/store.js';
import { AppError, type Permissions, type Principal, type TokenRecord } from '../shared/types.js';
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export class TokenManager {
  constructor(private store: ConfigStore) {}
  publicRecords() {
    return this.store.state.tokens.map(({ hash: _hash, oauth, ...record }) => ({
      ...record,
      ...(oauth
        ? {
            oauth: {
              clientId: oauth.clientId,
              resource: oauth.resource,
              workspaceIds: [...oauth.workspaceIds],
            },
          }
        : {}),
    }));
  }
  async create(
    name: string,
    workspaceId: string,
    permissions: Permissions,
    expiresInHours?: number,
  ) {
    const token = 'mcpc_' + randomBytes(32).toString('base64url');
    const record: TokenRecord = {
      id: randomUUID(),
      name,
      hash: tokenHash(token),
      workspaceId,
      permissions: { ...permissions },
      createdAt: new Date().toISOString(),
      ...(expiresInHours
        ? { expiresAt: new Date(Date.now() + expiresInHours * 3600_000).toISOString() }
        : {}),
    };
    this.store.state.tokens.push(record);
    await this.store.save();
    return { token, record: this.publicRecords().find((t) => t.id === record.id)! };
  }
  verify(token: string, resource?: string): Principal {
    if (token.length > 128 || !token.startsWith('mcpc_'))
      throw new AppError('Invalid access token.', 401);
    const hash = Buffer.from(tokenHash(token), 'hex');
    const record = this.store.state.tokens.find((t) =>
      timingSafeEqual(Buffer.from(t.hash, 'hex'), hash),
    );
    if (
      !record ||
      record.revokedAt ||
      (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())
    )
      throw new AppError('Invalid, expired or revoked access token.', 401);
    if (record.oauth && (!resource || resource !== record.oauth.resource))
      throw new AppError('Token audience does not match this MCP endpoint.', 401);
    if (!record.oauth && record.workspaceId !== this.store.state.activeWorkspaceId)
      throw new AppError('Token workspace is not active.', 403);
    if (!this.valid(record.id)) throw new AppError('Token workspace is unavailable.', 403);
    const workspaceId = record.oauth
      ? record.oauth.workspaceIds.find((id) =>
          this.store.state.workspaces.some((w) => w.id === id),
        )!
      : record.workspaceId;
    return {
      tokenId: record.id,
      name: record.name,
      workspaceId,
      permissions: { ...(record.oauth?.workspacePermissions[workspaceId] || record.permissions) },
      ...(record.oauth
        ? {
            workspaceIds: record.oauth.workspaceIds.filter((id) =>
              this.store.state.workspaces.some((w) => w.id === id),
            ),
            workspacePermissions: structuredClone(record.oauth.workspacePermissions),
            resource: record.oauth.resource,
          }
        : {}),
    };
  }
  valid(id: string, workspaceId?: string) {
    const record = this.store.state.tokens.find((t) => t.id === id);
    return (
      !!record &&
      !record.revokedAt &&
      (!record.expiresAt || Date.parse(record.expiresAt) > Date.now()) &&
      (record.oauth
        ? record.oauth.workspaceIds.some(
            (id) =>
              (!workspaceId || id === workspaceId) &&
              this.store.state.workspaces.some((w) => w.id === id),
          )
        : record.workspaceId === this.store.state.activeWorkspaceId &&
          (!workspaceId || workspaceId === record.workspaceId))
    );
  }
  async revoke(id: string) {
    const record = this.store.state.tokens.find((t) => t.id === id);
    if (!record) throw new AppError('Token not found.', 404);
    record.revokedAt = new Date().toISOString();
    await this.store.save();
  }
}
