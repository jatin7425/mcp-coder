import {
  AppError,
  permissionKeys,
  type Permissions,
  type Principal,
  type Workspace,
} from '../shared/types.js';
export function intersect(a: Permissions, b: Permissions): Permissions {
  return Object.fromEntries(
    permissionKeys.map((k) => [k, a[k] === true && b[k] === true]),
  ) as Permissions;
}
export function requireRead(workspace: Workspace, principal: Principal) {
  if (
    workspace.id !== principal.workspaceId ||
    (principal.workspaceIds && !principal.workspaceIds.includes(workspace.id))
  )
    throw new AppError('Workspace access is denied.', 403);
  const policy = intersect(workspace.permissions, principal.permissions);
  if (!policy.read) throw new AppError('Workspace read access is denied.', 403);
  return policy;
}
export function requireTerminal(workspace: Workspace, principal: Principal) {
  const policy = requireRead(workspace, principal);
  if (!policy.write || !policy.execute || !policy.git)
    throw new AppError(
      'Terminal requires Read, Modify, Execute and Git permissions. Use structured read tools for read-only access.',
      403,
    );
  return policy;
}
