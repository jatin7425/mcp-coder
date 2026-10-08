import { posix, win32 } from 'node:path';
export type DesktopPlatform = 'linux' | 'darwin' | 'win32';
export function hostPaths(platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? win32 : posix;
}
export function normalizeHostPath(path: string, platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') path = path.replace(/^\\\\\?\\(?=[A-Za-z]:)/, '');
  const paths = hostPaths(platform);
  const normalized = paths.resolve(path);
  const key = platform === 'win32' ? normalized.toLowerCase() : normalized;
  return normalized === paths.parse(normalized).root ? key : key.replace(/[\\/]+$/, '');
}
export function sameHostPath(a: string, b: string, platform: NodeJS.Platform = process.platform) {
  return normalizeHostPath(a, platform) === normalizeHostPath(b, platform);
}
export function isWithinHostPath(
  path: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
) {
  const paths = hostPaths(platform);
  const relative = paths.relative(
    normalizeHostPath(root, platform),
    normalizeHostPath(path, platform),
  );
  return (
    relative === '' ||
    (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep))
  );
}
export function macSystemAlias(path: string, target: string) {
  return ['/tmp', '/var', '/etc'].includes(path) && target === '/private' + path;
}
export function sandboxIdentity(
  platform: NodeJS.Platform = process.platform,
  uid = process.getuid?.(),
  gid = process.getgid?.(),
) {
  // Unix bind mounts preserve the host UID/GID. Windows has no Unix identity;
  // its Desktop file-sharing backend uses a fixed non-root container user.
  return platform === 'linux' || platform === 'darwin'
    ? { uid: uid && uid > 0 ? uid : 1000, gid: gid && gid > 0 ? gid : 1000 }
    : { uid: 1000, gid: 1000 };
}
export function platformConfigDirectory(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
) {
  const paths = hostPaths(platform);
  if (env.MCP_CODE_HOME) return env.MCP_CODE_HOME;
  if (platform === 'win32')
    return paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'mcp-code');
  if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support', 'mcp-code');
  return paths.join(env.XDG_CONFIG_HOME || paths.join(home, '.config'), 'mcp-code');
}

export function isWithinProtectedHostPath(
  path: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
) {
  // macOS may use case-sensitive or case-insensitive volumes. Protected trees
  // reject case variants conservatively; ordinary path identity keeps its case.
  return isWithinHostPath(
    platform === 'darwin' ? path.toLowerCase() : path,
    platform === 'darwin' ? root.toLowerCase() : root,
    platform,
  );
}

export function dockerMountSource(path: string, platform: NodeJS.Platform = process.platform) {
  // Node may return the Windows extended-length prefix; Docker expects a drive path.
  return platform === 'win32' ? path.replace(/^\\\\\?\\(?=[A-Za-z]:)/, '') : path;
}
