import { z } from 'zod';
import type { TerminalManager } from '../terminal/manager.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import { requireRead } from '../permissions/policy.js';
import type { AuditLogger } from '../audit/store.js';
import { AppError, message, type Principal } from '../shared/types.js';
export const toolSchemas = {
  list_workspaces: z.object({}),
  workspace_info: z.object({ workspaceId: z.string().uuid().optional() }),
  terminal_execute: z.object({
    workspaceId: z.string().uuid().optional(),
    command: z.string().min(1).max(16384),
    timeout: z.number().int().min(100).max(3600000).default(120000),
    cwd: z.string().max(4096).default('/workspace'),
    background: z.boolean().default(false),
  }),
  terminal_status: z.object({ id: z.string().uuid() }),
  terminal_cancel: z.object({ id: z.string().uuid() }),
  read_file: z.object({
    workspaceId: z.string().uuid().optional(),
    path: z.string().min(1).max(4096),
    offset: z.number().int().min(0).max(10_000_000).default(0),
    limit: z.number().int().min(1).max(100_000).default(20_000),
  }),
  directory_tree: z.object({
    workspaceId: z.string().uuid().optional(),
    path: z.string().max(4096).default('.'),
    depth: z.number().int().min(1).max(5).default(2),
  }),
  search_text: z.object({
    workspaceId: z.string().uuid().optional(),
    query: z.string().min(1).max(1024),
    path: z.string().max(4096).default('.'),
  }),
};
export type ToolName = keyof typeof toolSchemas;
export const descriptions: Record<ToolName, string> = {
  list_workspaces:
    'List only the workspaces approved for this client, with IDs and effective permissions. Pass workspaceId to workspace tools to choose one. Host paths are never returned.',
  workspace_info:
    'Show the active workspace and effective permissions. Host paths are never returned.',
  terminal_execute:
    'Execute a shell command inside the isolated /workspace container. Requires Read, Modify, Execute and Git. Set background=true to poll/cancel a job. In approval mode returns a pending job; a human must approve it in the dashboard.',
  terminal_status: 'Inspect your command job and bounded stdout/stderr result.',
  terminal_cancel: 'Cancel your command and terminate its container including child processes.',
  read_file:
    'Read a bounded UTF-8 file slice inside the active workspace. Works with read-only permissions.',
  directory_tree: 'List a bounded workspace directory tree without following symlinks.',
  search_text: 'Search literal text in workspace files with bounded output.',
};
// Structured reads run fixed code inside read-only containers. Arguments are data, never shell fragments.
const reader = `import os,sys,json,stat
args=json.loads(sys.argv[1]); root='/workspace'
def safe(p):
 p=os.path.realpath(os.path.join(root,p))
 if os.path.commonpath([root,p])!=root: raise ValueError('Path escapes workspace')
 return p
op=args['op']; p=safe(args.get('path','.'))
if op=='read_file':
 fd=os.open(p,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW)
 try:
  if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError('Only regular files can be read')
  with os.fdopen(fd,'rb',closefd=False) as f: f.seek(args['offset']); data=f.read(args['limit']+1)
  print(json.dumps({'path':os.path.relpath(p,root),'text':data[:args['limit']].decode('utf-8','replace'),'truncated':len(data)>args['limit']}))
 finally: os.close(fd)
elif op=='directory_tree':
 entries=[]
 for current,dirs,files in os.walk(p,followlinks=False):
  depth=len(os.path.relpath(current,p).split(os.sep)) if current!=p else 0
  dirs.sort(); files.sort()
  if depth>=args['depth']: dirs[:]=[]
  for name in dirs+files:
   item=os.path.join(current,name); entries.append({'path':os.path.relpath(item,root),'type':'symlink' if os.path.islink(item) else 'directory' if os.path.isdir(item) else 'file'})
   if len(entries)>=1000: break
  if len(entries)>=1000: break
 print(json.dumps({'entries':entries,'truncated':len(entries)>=1000}))
else:
 import subprocess
 proc=subprocess.Popen(['rg','--fixed-strings','--line-number','--no-heading','--max-count','30','--glob','!node_modules/**','--glob','!.git/**','--',args['query'],p],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 out=proc.stdout.read(100001)
 if len(out)>100000: proc.kill()
 try: err=proc.communicate(timeout=10)[1]
 except subprocess.TimeoutExpired: proc.kill(); err=proc.communicate()[1]
 print(json.dumps({'matches':out[:100000].decode('utf-8','replace').replace(root+'/',''),'truncated':len(out)>100000}))
`;
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export class ToolService {
  constructor(
    private terminals: TerminalManager,
    private workspaces: WorkspaceManager,
    private audit?: AuditLogger,
  ) {}
  async call(name: ToolName, raw: unknown, principal: Principal, signal?: AbortSignal) {
    const args = toolSchemas[name].parse(raw);
    if (name === 'list_workspaces') {
      return {
        workspaces: (principal.workspaceIds || [principal.workspaceId]).map((id) => {
          const workspace = this.workspaces.get(id);
          const selected = this.selectWorkspace(principal, id);
          return {
            id,
            name: workspace.name,
            permissions: requireRead(workspace, selected),
            approvalMode: workspace.approvalMode,
          };
        }),
      };
    }
    const requestedId = (args as { workspaceId?: string }).workspaceId;
    if (requestedId) principal = this.selectWorkspace(principal, requestedId);
    const workspace = this.workspaces.get(principal.workspaceId);
    if (name === 'workspace_info') {
      const policy = requireRead(workspace, principal);
      return {
        id: workspace.id,
        name: workspace.name,
        path: '/workspace',
        permissions: policy,
        approvalMode: workspace.approvalMode,
      };
    }
    if (name === 'terminal_status')
      return this.terminals.status((args as { id: string }).id, principal);
    if (name === 'terminal_cancel') {
      const id = (args as { id: string }).id;
      await this.terminals.cancel(id, principal);
      return this.terminals.status(id, principal);
    }
    if (name === 'terminal_execute') {
      const input = args as z.infer<typeof toolSchemas.terminal_execute>;
      const job = await this.terminals.submit(principal, input);
      if (input.background || job.status === 'awaiting-approval') return job;
      const completed = await this.wait(job.id, principal, signal);
      if (completed.error) throw new Error(completed.error);
      return { id: job.id, ...completed.result };
    }
    const command = `python3 -c ${shellQuote(reader)} ${shellQuote(JSON.stringify({ ...args, op: name }))}`;
    const job = await this.terminals.submit(
      principal,
      { command, cwd: '/workspace', timeout: 30000 },
      true,
      name,
    );
    const completed = await this.wait(job.id, principal, signal);
    if (completed.error) throw new Error(completed.error);
    if (completed.result?.exitCode !== 0)
      throw new Error(completed.result?.stderr || 'Read operation failed.');
    try {
      return JSON.parse(completed.result.stdout);
    } catch {
      throw new Error('Reader returned an invalid result.');
    }
  }
  private selectWorkspace(principal: Principal, id: string): Principal {
    if (!(principal.workspaceIds || [principal.workspaceId]).includes(id))
      throw new AppError('This workspace was not approved for this client.', 403);
    return {
      ...principal,
      workspaceId: id,
      permissions: { ...(principal.workspacePermissions?.[id] || principal.permissions) },
    };
  }
  private async wait(id: string, principal: Principal, signal?: AbortSignal) {
    const cancel = () => {
      void this.terminals.cancel(id, principal).catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      return await this.terminals.wait(id, principal);
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  async result(name: ToolName, args: unknown, principal: Principal, signal?: AbortSignal) {
    try {
      const result = await this.call(name, args, principal, signal);
      if (
        ['list_workspaces', 'workspace_info', 'terminal_status', 'terminal_cancel'].includes(name)
      )
        await this.audit?.record({
          client: principal.name,
          workspaceId:
            name === 'workspace_info'
              ? (result as { id: string }).id
              : name === 'terminal_status' || name === 'terminal_cancel'
                ? (result as { workspaceId: string }).workspaceId
                : principal.workspaceId,
          tool: name,
          result: 'allowed',
        });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (error) {
      if (
        ['list_workspaces', 'workspace_info', 'terminal_status', 'terminal_cancel'].includes(name)
      )
        await this.audit
          ?.record({
            client: principal.name,
            workspaceId: principal.workspaceId,
            tool: name,
            result: error instanceof AppError && error.status === 403 ? 'denied' : 'error',
          })
          .catch(() => {});
      return { isError: true, content: [{ type: 'text' as const, text: message(error) }] };
    }
  }
}
