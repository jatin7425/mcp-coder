import { defaultResources } from '../shared/types.js';
import { randomUUID } from 'node:crypto';
import type { SandboxProvider } from '../sandbox/provider.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { TokenManager } from '../authentication/tokens.js';
import type { AuditLogger } from '../audit/store.js';
import { requireRead, requireTerminal } from '../permissions/policy.js';
import { normalizeCwd } from '../sandbox/docker.js';
import { AppError, message, type CommandInput, type Job, type Principal } from '../shared/types.js';
interface ManagedJob {
  public: Job;
  controller: AbortController;
  promise: Promise<Job>;
  resolve: (job: Job) => void;
  principal: Principal;
  input: CommandInput;
  readonly: boolean;
  approvalTimer?: NodeJS.Timeout;
}
export interface SessionStore {
  list(): Job[];
}
export class TerminalManager implements SessionStore {
  private jobs = new Map<string, ManagedJob>();
  private stopping = false;
  private suspended = 0;
  suspend() {
    this.suspended++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.suspended--;
      }
    };
  }
  private maintenance: NodeJS.Timeout;
  constructor(
    private sandbox: SandboxProvider,
    private workspaces: WorkspaceManager,
    private tokens: TokenManager,
    private audit: AuditLogger,
  ) {
    this.maintenance = setInterval(() => {
      for (const job of this.jobs.values())
        if (
          ['running', 'awaiting-approval'].includes(job.public.status) &&
          !this.tokens.valid(job.principal.tokenId, job.principal.workspaceId)
        )
          void this.cancel(job.public.id);
    }, 1000);
    this.maintenance.unref();
  }
  list() {
    return [...this.jobs.values()].map((j) => j.public).reverse();
  }
  status(id: string, principal?: Principal) {
    const job = this.jobs.get(id);
    if (!job || (principal && job.principal.tokenId !== principal.tokenId))
      throw new AppError('Command not found.', 404);
    return job.public;
  }
  async submit(
    principal: Principal,
    input: CommandInput,
    readonly = false,
    tool = 'terminal_execute',
  ) {
    if (this.suspended)
      throw new AppError('Workspace configuration is changing. Retry shortly.', 503);
    if (this.stopping) throw new AppError('Runtime is stopping.', 503);
    if (!this.tokens.valid(principal.tokenId, principal.workspaceId))
      throw new AppError('Token is no longer valid.', 401);
    const workspace = this.workspaces.get(principal.workspaceId);
    let policy;
    try {
      policy = readonly ? requireRead(workspace, principal) : requireTerminal(workspace, principal);
    } catch (error) {
      await this.audit.record({
        client: principal.name,
        workspaceId: workspace.id,
        tool,
        command: readonly ? undefined : input.command,
        result: 'denied',
      });
      throw error;
    }
    normalizeCwd(input.cwd);
    if (
      input.command.length > 16_384 ||
      input.timeout < 100 ||
      !Number.isInteger(input.timeout) ||
      input.timeout > 3_600_000
    )
      throw new AppError('Invalid command length or timeout (100–3600000 ms).');
    if (this.list().filter((j) => ['running', 'awaiting-approval'].includes(j.status)).length >= 8)
      throw new AppError('Too many pending commands. Cancel a command first.', 429);
    if (
      this.list().filter(
        (j) =>
          j.tokenId === principal.tokenId && ['running', 'awaiting-approval'].includes(j.status),
      ).length >= 3
    )
      throw new AppError('Client command limit reached.', 429);
    input = {
      ...input,
      timeout: Math.min(
        input.timeout,
        (workspace.resources || defaultResources).timeoutSeconds * 1000,
      ),
    };
    const needsApproval = !readonly && workspace.approvalMode === 'ask';
    const publicJob: Job = {
      id: randomUUID(),
      workspaceId: workspace.id,
      client: principal.name,
      tokenId: principal.tokenId,
      command: readonly ? tool : input.command,
      status: needsApproval ? 'awaiting-approval' : 'running',
      createdAt: new Date().toISOString(),
    };
    let complete!: (job: Job) => void;
    const job: ManagedJob = {
      public: publicJob,
      controller: new AbortController(),
      promise: new Promise((resolve) => {
        complete = resolve;
      }),
      resolve: complete,
      principal,
      input,
      readonly,
    };
    this.jobs.set(publicJob.id, job);
    // Completed output is memory-only and bounded to 100 records.
    for (const [id, old] of this.jobs)
      if (this.jobs.size > 100 && ['completed', 'denied'].includes(old.public.status))
        this.jobs.delete(id);
    if (needsApproval)
      job.approvalTimer = setTimeout(() => {
        void this.cancel(publicJob.id);
      }, 120_000);
    else void this.run(job, policy, tool);
    return publicJob;
  }
  private async run(job: ManagedJob, policy: Principal['permissions'], tool: string) {
    const workspace = this.workspaces.get(job.public.workspaceId);
    try {
      job.public.result = await this.sandbox.execute({
        id: job.public.id,
        workspace: { ...workspace, permissions: { ...workspace.permissions } },
        permissions: { ...policy, ...(job.readonly ? { write: false, network: false } : {}) },
        input: job.input,
        signal: job.controller.signal,
      });
      await this.audit.record({
        client: job.principal.name,
        workspaceId: workspace.id,
        tool,
        command: job.readonly ? undefined : job.input.command,
        duration: job.public.result.duration,
        exitCode: job.public.result.exitCode,
        result: 'allowed',
      });
    } catch (error) {
      if (job.controller.signal.aborted)
        job.public.result = {
          exitCode: 130,
          stdout: '',
          stderr: '',
          duration: 0,
          truncated: false,
          timedOut: false,
          cancelled: true,
        };
      else job.public.error = message(error);
      await this.audit
        .record({
          client: job.principal.name,
          workspaceId: workspace.id,
          tool,
          command: job.readonly ? undefined : job.input.command,
          result: 'error',
        })
        .catch(() => {});
    } finally {
      job.public.status = 'completed';
      job.resolve(job.public);
    }
  }
  async wait(id: string, principal?: Principal) {
    this.status(id, principal);
    return this.jobs.get(id)!.promise;
  }
  async approve(id: string, approved: boolean) {
    const job = this.jobs.get(id);
    if (!job || job.public.status !== 'awaiting-approval')
      throw new AppError('Approval request not found.', 404);
    clearTimeout(job.approvalTimer);
    if (!approved || !this.tokens.valid(job.principal.tokenId, job.principal.workspaceId)) {
      await this.cancel(id);
      return;
    }
    const workspace = this.workspaces.get(job.principal.workspaceId);
    const policy = requireTerminal(workspace, job.principal);
    job.public.status = 'running';
    void this.run(job, policy, 'terminal_execute');
  }
  async cancel(id: string, principal?: Principal) {
    this.status(id, principal);
    const job = this.jobs.get(id)!;
    if (job.public.status === 'awaiting-approval') {
      clearTimeout(job.approvalTimer);
      job.public.status = 'denied';
      job.public.error = 'Command approval denied or expired.';
      job.resolve(job.public);
      await this.audit.record({
        client: job.principal.name,
        workspaceId: job.public.workspaceId,
        tool: 'terminal_execute',
        command: job.input.command,
        result: 'denied',
      });
    } else if (job.public.status === 'running') {
      job.controller.abort();
      await job.promise;
    }
  }
  async cancelWhere(predicate: (job: Job) => boolean) {
    await Promise.all(
      [...this.jobs.values()]
        .filter((j) => predicate(j.public))
        .map((j) => this.cancel(j.public.id)),
    );
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.maintenance);
    await this.cancelWhere(() => true);
    await this.sandbox.stopAll();
  }
}
