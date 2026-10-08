# Extending MCP Code

## Tunnel providers

Implement `TunnelProvider` from `packages/tunnel-manager/provider.ts`, then register the adapter with `TunnelManager.register()`. The dashboard retrieves the provider inventory from `/api/tunnels/providers`. Registered providers appear as tabs on the Remote access page. Add provider-specific setup guidance when its flow differs from the native CLI forms.

A provider must report its actual public HTTPS URL, forward only the public gateway port, preserve owner authentication for dashboard access and agent authentication at the MCP layer, own and clean up its subprocesses, and report errors. Use argument-array subprocesses, never interpolate credentials into shell commands. Prefer native provider authentication. Do not add a plaintext JSON token fallback: `CredentialStore.set` deliberately refuses to persist secrets without a secure implementation.

Cloudflare and ngrok use the shared native subprocess lifecycle in `native.ts`. ngrok requires its installed CLI and native authtoken configuration; the app does not store provider credentials. Its adapter accepts HTTPS URLs only from JSON `started tunnel` events. Other providers remain extension targets.

## Sandbox providers

Implement `SandboxProvider` in `packages/sandbox/provider.ts`. `execute` accepts the canonical workspace, effective policy, fixed timeout, command/cwd, and cancellation signal. It must enforce mount and network permissions through its OS isolation mechanism and return bounded output. `recover` cleans leftovers scoped to the installation; `stopAll` terminates all owned execution. Reject unsupported restrictions rather than displaying successful permission toggles.

Container names and installation labels are implementation-owned. Never take them from the AI client. Never expose the host Docker socket inside the sandbox. A future VM provider may offer a stronger boundary than Docker's shared kernel.

## Tools

Add a Zod input schema and description to `packages/mcp-server/tools.ts`, then implement `ToolService.call`. HTTP and stdio automatically share the tool definitions. Apply effective workspace/token policy before accessing the sandbox. Tool metadata and annotations are hints for clients, not enforcement. Fixed reader code and JSON arguments must remain separated from shell fragments.

## Storage

`ConfigStore`, `WorkspaceStore`, `SessionStore`, `AuditStore` and `CredentialStore` are interfaces. The default implementation stores non-secret state atomically, bounds command/session history in memory, and persists audit metadata. Raw bearer tokens must not become ordinary application state. New persistent session backends must preserve per-token job ownership and retention limits.
