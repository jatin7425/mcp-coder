import type { CommandInput, CommandResult, Permissions, Workspace } from '../shared/types.js';
export interface SandboxExecution {
  id: string;
  workspace: Workspace;
  permissions: Permissions;
  input: CommandInput;
  signal: AbortSignal;
}
export interface SandboxProvider {
  id: string;
  availability(): Promise<{ available: boolean; imageReady: boolean; detail: string }>;
  execute(execution: SandboxExecution): Promise<CommandResult>;
  recover(): Promise<void>;
  stopAll(): Promise<void>;
}
