import { randomUUID } from 'node:crypto';
import type { SandboxProvider } from '../sandbox/provider.js';
import { AppError, type Workspace } from '../shared/types.js';
// All repository code and Git configuration remain inside a read-only, networkless sandbox.
const script = String.raw`import subprocess,json,os,stat,threading
root='/workspace'
def git(args,limit=30000):
 p=subprocess.Popen(['git','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.quotePath=true','-c','color.ui=false']+args,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={**os.environ,'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_PAGER':'cat'})
 timer=threading.Timer(8,p.kill); timer.start()
 try:
  data=p.stdout.read(limit+1)
  if len(data)>limit: p.kill()
  code=p.wait()
  return data[:limit],len(data)>limit,code
 finally: timer.cancel()
_,_,code=git(['rev-parse','--show-toplevel'])
if code: print(json.dumps({'repository':False,'files':[],'staged':'','working':'','untracked':[],'truncated':False})); raise SystemExit()
status,truncated,_=git(['status','--porcelain=v1','-z','--untracked-files=all'],20000)
parts=status.split(b'\0'); files=[]; untracked=[]; i=0; budget=20000
while i<len(parts):
 entry=parts[i]; i+=1
 if len(entry)<4: continue
 flags=entry[:2].decode('ascii','replace'); path=os.fsdecode(entry[3:])
 if 'R' in flags or 'C' in flags: i+=1
 files.append({'status':flags,'path':path})
 if flags=='??' and len(untracked)<20:
  absolute=os.path.realpath(os.path.join(root,path))
  if os.path.commonpath([root,absolute])!=root or os.path.islink(os.path.join(root,path)): continue
  try:
   fd=os.open(absolute,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW)
   try:
    if not stat.S_ISREG(os.fstat(fd).st_mode): continue
    data=os.read(fd,min(4000,budget)+1)
   finally: os.close(fd)
   size=min(4000,budget); limited=len(data)>size; data=data[:size]; budget-=len(data)
   untracked.append({'path':path,'text':'Binary file' if b'\0' in data else data.decode('utf-8','replace'),'truncated':limited})
  except OSError: pass
 if len(files)>=200: truncated=True; break
staged,st,_=git(['diff','--cached','--no-ext-diff','--no-textconv','--no-color','--'])
working,wt,_=git(['diff','--no-ext-diff','--no-textconv','--no-color','--'])
print(json.dumps({'repository':True,'files':files,'staged':staged.decode('utf-8','replace'),'working':working.decode('utf-8','replace'),'untracked':untracked,'truncated':truncated or st or wt or sum(f['status']=='??' for f in files)>len(untracked)}))
`;
export async function workspaceChanges(
  sandbox: SandboxProvider,
  workspace: Workspace,
  signal: AbortSignal,
) {
  if (!workspace.permissions.read)
    throw new AppError('Enable workspace read access to review changes.', 403);
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const result = await sandbox.execute({
    id: randomUUID(),
    workspace,
    permissions: { read: true, write: false, execute: false, git: false, network: false },
    input: { command: `python3 -c ${quote(script)}`, cwd: '/workspace', timeout: 30000 },
    signal,
  });
  if (result.exitCode !== 0 || result.truncated)
    throw new AppError(
      'Change review could not finish. Check Docker and retry with a smaller repository.',
      503,
    );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new AppError(
      'Change review returned an incomplete result. Retry after checking Docker.',
      503,
    );
  }
}
