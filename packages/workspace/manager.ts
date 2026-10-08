import { lstat, realpath } from 'node:fs/promises';
import { resolve, parse, sep, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const applicationDirectory = resolve(
  fileURLToPath(
    new URL(import.meta.url.includes('/dist/packages/') ? '../../../' : '../../', import.meta.url),
  ),
);
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConfigStore } from '../config/store.js';
import { isWithinProtectedHostPath, sameHostPath, macSystemAlias } from '../shared/platform.js';
import { AppError, defaultPermissions, type Workspace } from '../shared/types.js';
const run = promisify(execFile);
export interface WorkspaceStore {
  list(): Workspace[];
  get(id: string): Workspace;
}
export async function validateWorkspace(input: string, configDir: string): Promise<string> {
  if (!input || input.includes('\0') || input.includes(','))
    throw new AppError(
      'Select a valid folder (commas in folder names are unsupported by Docker mounts).',
    );
  if (
    process.platform === 'win32' &&
    /^(?:\\\\|\/\/)/.test(input) &&
    !/^\\\\\?\\[A-Za-z]:/.test(input)
  )
    throw new AppError(
      'Choose a local drive folder; network shares are not supported as isolated local workspaces.',
    );
  const path = resolve(input.startsWith('~/') ? join(homedir(), input.slice(2)) : input);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new AppError('Workspace must be a real directory, not a symlink.');
  const canonical = await realpath(path);
  const appRoot = await realpath(applicationDirectory);
  if (
    isWithinProtectedHostPath(canonical, appRoot) ||
    isWithinProtectedHostPath(appRoot, canonical)
  )
    throw new AppError(
      'Choose a project outside the running MCP Code installation. Install MCP Code separately to work on its source.',
    );
  const home = await realpath(homedir());
  const credentialRoots = ['.ssh', '.aws', '.config', '.gnupg', '.kube', '.docker', '.codex'].map(
    (x) => join(home, x),
  );
  const systems =
    process.platform === 'win32'
      ? [
          process.env.WINDIR || 'C:\\Windows',
          process.env.ProgramFiles,
          process.env['ProgramFiles(x86)'],
          process.env.ProgramData,
          process.env.APPDATA,
          process.env.LOCALAPPDATA,
        ].filter((p): p is string => !!p)
      : [
          '/etc',
          '/proc',
          '/sys',
          '/dev',
          '/run',
          '/var/run',
          '/root',
          '/usr',
          '/bin',
          '/sbin',
          '/boot',
          ...(process.platform === 'darwin'
            ? [
                '/System',
                '/Library',
                '/private/etc',
                '/private/var/root',
                '/private/var/run',
                join(home, 'Library'),
              ]
            : []),
        ];
  const canonicalConfig = await realpath(configDir).catch(() => resolve(configDir));
  const protectedRoots = [canonicalConfig, ...credentialRoots, ...systems];
  if (
    sameHostPath(canonical, parse(canonical).root) ||
    isWithinProtectedHostPath(home, canonical) ||
    protectedRoots.some((p) => isWithinProtectedHostPath(canonical, p)) ||
    isWithinProtectedHostPath(canonicalConfig, canonical)
  )
    throw new AppError(
      'Choose a project folder, not a system, home, credential, or MCP Code configuration folder.',
    );
  // Inspect parents explicitly: a casing change on Windows is not a symlink, and
  // macOS intentionally aliases /var and /tmp into /private. All user-created
  // links/junctions remain rejected, including links to another permitted project.
  let parent = resolve(path, '..');
  while (!sameHostPath(parent, parse(parent).root)) {
    const parentInfo = await lstat(parent);
    if (parentInfo.isSymbolicLink()) {
      const target = await realpath(parent);
      if (process.platform !== 'darwin' || !macSystemAlias(parent, target))
        throw new AppError(
          'Workspace path must not contain symlinked parents. Select its real path.',
        );
    }
    parent = resolve(parent, '..');
  }
  return canonical;
}
export async function nativeFolderPicker(): Promise<string | undefined> {
  try {
    let stdout: string;
    if (process.platform === 'darwin')
      ({ stdout } = await run(
        'osascript',
        ['-e', 'POSIX path of (choose folder with prompt "Select an MCP Code workspace")'],
        { timeout: 120_000, windowsHide: true },
      ));
    else if (process.platform === 'win32')
      ({ stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-STA',
          '-Command',
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; if ($picker.ShowDialog() -eq "OK") { $picker.SelectedPath }',
        ],
        { timeout: 120_000, windowsHide: true },
      ));
    else {
      try {
        ({ stdout } = await run(
          'zenity',
          ['--file-selection', '--directory', '--title=Select an MCP Code workspace'],
          { timeout: 120_000, windowsHide: true },
        ));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        ({ stdout } = await run(
          'kdialog',
          ['--getexistingdirectory', homedir(), '--title', 'Select an MCP Code workspace'],
          { timeout: 120_000, windowsHide: true },
        ));
      }
    }
    return stdout.trim() || undefined;
  } catch (e) {
    if ((e as { code?: number }).code === 1) return undefined;
    throw new AppError(
      'Native folder selection is unavailable. Enter a local project path below. Linux also supports zenity/kdialog; Windows needs desktop PowerShell and macOS needs osascript.',
    );
  }
}
export class WorkspaceManager implements WorkspaceStore {
  constructor(
    private store: ConfigStore,
    private directory: string,
  ) {}
  list() {
    return this.store.state.workspaces;
  }
  get(id: string) {
    const workspace = this.list().find((w) => w.id === id);
    if (!workspace) throw new AppError('Workspace not found.', 404);
    return workspace;
  }
  active() {
    return this.store.state.activeWorkspaceId
      ? this.get(this.store.state.activeWorkspaceId)
      : undefined;
  }
  async add(path: string, name?: string) {
    path = await validateWorkspace(path, this.directory);
    if (this.list().some((w) => sameHostPath(w.path, path)))
      throw new AppError('That folder is already registered.');
    const workspace: Workspace = {
      id: randomUUID(),
      name: name?.trim().slice(0, 80) || path.split(sep).at(-1) || 'Project',
      path,
      permissions: { ...defaultPermissions },
      approvalMode: 'autonomous',
      createdAt: new Date().toISOString(),
    };
    this.store.state.workspaces.push(workspace);
    if (!this.store.state.activeWorkspaceId) this.store.state.activeWorkspaceId = workspace.id;
    await this.store.save();
    return workspace;
  }
}
