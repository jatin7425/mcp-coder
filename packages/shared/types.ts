export const permissionKeys = ['read', 'write', 'execute', 'git', 'network'] as const;
export type Permissions = Record<(typeof permissionKeys)[number], boolean>;
export const defaultPermissions: Permissions = {
  read: true,
  write: true,
  execute: true,
  git: true,
  network: false,
};
export interface Workspace {
  id: string;
  name: string;
  path: string;
  permissions: Permissions;
  approvalMode: 'autonomous' | 'ask';
  createdAt: string;
}
export interface TokenRecord {
  id: string;
  name: string;
  hash: string;
  workspaceId: string;
  permissions: Permissions;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  oauth?: {
    clientId: string;
    resource: string;
    workspaceIds: string[];
    workspacePermissions: Record<string, Permissions>;
    refreshHash: string;
    refreshExpiresAt: string;
    previousRefreshHashes: string[];
  };
}
export interface OAuthClientRecord {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post';
  grant_types: string[];
  response_types: string[];
  secretHash?: string;
  client_secret_expires_at?: number;
}
export interface AuditEntry {
  id: string;
  timestamp: string;
  client: string;
  workspaceId: string;
  tool: string;
  command?: string;
  duration?: number;
  exitCode?: number;
  result: 'allowed' | 'denied' | 'error';
}
export interface AppState {
  schemaVersion: 1;
  workspaces: Workspace[];
  activeWorkspaceId?: string;
  tokens: TokenRecord[];
  settings: { uiPort: number; mcpPort: number; retentionDays: number };
  audit: AuditEntry[];
  oauthClients?: OAuthClientRecord[];
}
export interface Principal {
  tokenId: string;
  name: string;
  workspaceId: string;
  permissions: Permissions;
  workspaceIds?: string[];
  workspacePermissions?: Record<string, Permissions>;
  resource?: string;
}
export interface CommandInput {
  command: string;
  timeout: number;
  cwd: string;
}
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}
export interface Job {
  id: string;
  workspaceId: string;
  client: string;
  tokenId: string;
  command: string;
  status: 'awaiting-approval' | 'running' | 'completed' | 'denied';
  createdAt: string;
  result?: CommandResult;
  error?: string;
}
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
