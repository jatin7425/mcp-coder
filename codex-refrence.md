# MCP Code — Open-Source Local Coding MCP Server

Build an open-source project called **MCP Code**.

MCP Code allows a user to expose a selected folder on their local computer to any AI client that supports MCP (Model Context Protocol). The AI should be able to inspect the project, understand it, modify files, execute commands, run tests/builds, use Git, and perform coding-agent workflows similar to Claude Code or Codex.

The fundamental philosophy is:

> The user's files and execution environment remain on the user's machine. MCP Code provides the secure bridge between an MCP-capable AI and that local workspace.

MCP Code itself must not require any centrally hosted MCP Code infrastructure.

---

# 1. User Experience

Installation should be simple.

Support:

```bash
npm install -g mcp-code
```

and preferably:

```bash
npx mcp-code
```

The executable command should be:

```bash
mcp-code
```

Running this command should require no configuration arguments.

Example:

```text
$ mcp-code

Starting MCP Code...

✓ Runtime started
✓ Web UI started

Opening MCP Code...

http://localhost:7865
```

The CLI exists primarily as a launcher.

All actual configuration must happen through the Web UI.

If MCP Code is already running and the user executes:

```bash
mcp-code
```

again, do not create another runtime.

Instead:

```text
MCP Code is already running.
Opening http://localhost:7865...
```

and open the existing UI.

---

# 2. High-Level Architecture

Use this conceptual architecture:

```text
                        MCP-capable AI
                 ChatGPT / Claude / IDE / etc.
                              |
                              |
                             MCP
                              |
                              v
                     Public/Local Endpoint
                              |
                              v
+----------------------------------------------------+
|                 MCP CODE — LOCAL                   |
|                                                    |
|                 MCP Code Daemon                    |
|                                                    |
|       +-------------+   +----------------+          |
|       |   Web UI    |   |   MCP Server   |          |
|       +-------------+   +--------+-------+          |
|                                 |                  |
|       +-------------+           |                  |
|       |   Tunnel    |           |                  |
|       |   Manager   |           |                  |
|       +-------------+           |                  |
|                                 v                  |
|                         Security / Sandbox         |
|                                 |                  |
|                                 v                  |
|                          Terminal Runtime          |
|                                 |                  |
|                                 v                  |
|                            /workspace              |
|                                 |                  |
+---------------------------------|------------------+
                                  |
                                  v
                        User Selected Folder
```

Everything inside the MCP Code runtime executes locally.

MCP Code must not depend on an MCP Code-owned:

- cloud server
- domain
- database
- account system
- authentication backend
- relay server
- tunnel infrastructure

Remote access is provided through user-selected third-party tunneling providers.

---

# 3. CLI Responsibilities

The CLI should be intentionally minimal.

Its responsibilities are:

1. Check whether the MCP Code daemon is already running.
2. Start the daemon if necessary.
3. Start the local Web UI.
4. Start the local MCP runtime.
5. Open the user's default browser.
6. Print basic status information.
7. Avoid launching duplicate instances.

Do NOT put normal configuration into CLI arguments.

Configuration belongs in the Web UI.

---

# 4. Local Web UI

Default UI:

```text
http://localhost:7865
```

The Web UI is the main product interface.

Create a modern developer-tool dashboard.

Main navigation:

```text
Dashboard
Workspaces
Connections
Remote Access
Permissions
Activity
Settings
```

---

# 5. Workspace Management

Users should be able to select a folder from the Web UI.

Example:

```text
Workspace

/home/user/projects/my-project

[ Select Folder ]
```

Once selected, that directory becomes the workspace available to the MCP coding agent.

Internally represent it as:

```text
/workspace
```

Do not expose arbitrary host filesystem locations to the agent.

Support saving multiple workspace configurations.

Example:

```text
Workspaces

my-frontend
~/projects/frontend

backend-api
~/projects/backend

my-python-project
~/projects/python-app
```

Only explicitly activated workspaces should be accessible.

Each workspace should have its own permissions and sessions.

---

# 6. Workspace Permissions

The Web UI should provide controls such as:

```text
Permissions

[x] Read workspace
[x] Modify workspace
[x] Execute commands
[x] Git
[ ] Network access
```

Permissions must actually be enforced by the backend and must not merely be UI settings.

Design the permission system so more granular permissions can be added later.

---

# 7. Sandbox

Security is one of the most important components.

Do NOT simply execute commands using an unrestricted host shell.

The AI must execute commands inside a controlled environment.

Conceptually:

```text
AI
 |
 v
MCP
 |
 v
MCP Code
 |
 v
Sandbox
 |
 v
/workspace
 |
 v
Selected Host Folder
```

Only the selected workspace should be mounted or otherwise made accessible to the execution environment.

The sandbox must not automatically expose things such as:

```text
~/.ssh
~/.aws
~/.config
~/Documents
~/Downloads
browser data
host secrets
Docker socket
other projects
```

The sandbox should also avoid unnecessary access to host devices and privileged capabilities.

Design the sandbox behind an abstraction so different implementations can be supported later.

For the initial Linux implementation, container-based isolation may be used if appropriate.

Do not expose `/var/run/docker.sock` to the coding agent.

Prevent path traversal and symlink-based workspace escapes.

---

# 8. Terminal-Based Agent Capability

The initial MCP implementation should intentionally be terminal-centric.

Instead of implementing dozens of filesystem tools immediately, provide the agent with a controlled terminal capability.

Core MCP tool:

```text
terminal_execute
```

Suggested input:

```json
{
  "command": "npm test",
  "timeout": 120000
}
```

Suggested output:

```json
{
  "exitCode": 0,
  "stdout": "...",
  "stderr": "...",
  "duration": 1234
}
```

The agent should be able to use normal development tools available inside the sandbox.

Examples:

```bash
pwd
ls
find
tree

cat
sed
head
tail

grep
rg

git status
git diff
git log

node
npm
npx

python
python3
pip
pytest

make
```

This allows an MCP-capable coding agent to:

```text
inspect repository
        ↓
search code
        ↓
read relevant files
        ↓
modify files
        ↓
run tests
        ↓
inspect failures
        ↓
modify code
        ↓
run tests again
        ↓
inspect git diff
```

The architecture must allow structured filesystem MCP tools to be added later.

---

# 9. Additional MCP Tools

In addition to `terminal_execute`, implement a small set of management tools if useful:

```text
workspace_info
terminal_status
terminal_cancel
```

Potential future tools:

```text
read_file
read_files
write_file
edit_file
search_text
glob
directory_tree
git_status
git_diff
```

Keep the internal tool architecture modular.

---

# 10. Command Execution

The command execution engine must support:

- stdout
- stderr
- exit code
- configurable timeout
- cancellation
- working directory
- output limits
- process cleanup
- streaming architecture where appropriate

The working directory should default to:

```text
/workspace
```

Do not assume `cwd` alone provides security.

Actual sandbox isolation must enforce workspace boundaries.

---

# 11. MCP Transport

Support modern MCP transports required by MCP-capable clients.

At minimum architect for:

```text
stdio
Streamable HTTP
```

Local HTTP MCP could be exposed on something like:

```text
http://127.0.0.1:<dynamic-or-configured-port>/mcp
```

Do not bind publicly to all network interfaces by default.

Remote exposure should happen through the tunnel system.

---

# 12. Remote Access

MCP Code itself must not provide hosted infrastructure.

Instead implement a **Tunnel Manager**.

Architecture:

```text
MCP Server
    |
localhost
    |
    v
Tunnel Manager
    |
    +-- Cloudflare
    +-- ngrok
    +-- Tailscale
    +-- SSH/custom
    +-- future providers
```

Create a generic provider abstraction.

Conceptually:

```ts
interface TunnelProvider {
    id: string;
    name: string;

    checkAvailability(): Promise<boolean>;

    authenticate(config: unknown): Promise<void>;

    start(localPort: number): Promise<{
        publicUrl: string;
    }>;

    stop(): Promise<void>;

    status(): Promise<TunnelStatus>;
}
```

Provider-specific logic must live behind adapters.

Example project structure:

```text
tunnels/
    provider.ts
    cloudflare.ts
    ngrok.ts
    tailscale.ts
    ssh.ts
    custom.ts
```

---

# 13. Tunnel Web UI

Remote Access screen:

```text
Remote Access

Connection Mode

( ) Local only
( ) Cloudflare Tunnel
( ) ngrok
( ) Tailscale
( ) SSH / Custom
```

When a provider is selected, show the appropriate configuration.

Example:

```text
Cloudflare

CLI
✓ Installed

Authentication
✓ Connected

[ Start Tunnel ]
```

After starting:

```text
Tunnel
● Connected

Provider
Cloudflare

Public URL
https://<provider-generated-address>

MCP Endpoint
https://<provider-generated-address>/mcp

[ Copy MCP URL ]

[ Stop Tunnel ]
```

MCP Code must obtain and display whatever URL the tunnel provider actually supplies.

Do not assume MCP Code owns a domain.

---

# 14. Provider Credentials

Provider credentials belong to the user.

MCP Code should support the native authentication mechanisms of tunnel providers wherever practical.

For example:

```text
MCP Code
    |
    +-- Cloudflare native authentication
    |
    +-- ngrok credentials/token
    |
    +-- Tailscale authentication
    |
    +-- SSH credentials/config
```

MCP Code must never send these credentials to an MCP Code-controlled backend.

There is no such backend.

Sensitive credentials should not be stored in plaintext configuration files.

Use the operating system's secure credential storage/keychain where practical.

Create a credential-store abstraction.

---

# 15. MCP Authentication

Tunnel authentication and MCP authentication are different concerns.

A tunnel only makes the endpoint reachable.

The MCP endpoint itself must have its own access control when remotely exposed.

Implement token-based authentication.

Example:

```text
MCP URL

https://example-tunnel-url/mcp

Access Token

mcpc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Remote requests should require something equivalent to:

```text
Authorization: Bearer <token>
```

Tokens must be generated using a cryptographically secure random generator.

Never store raw tokens when a secure hashed representation is sufficient.

Provide functionality to:

- create token
- revoke token
- rotate token
- optionally expire token
- associate token with workspace
- associate token with permissions

Design for future per-client tokens.

Example:

```text
Client: ChatGPT

Workspace:
my-project

Permissions:
Read
Write
Terminal
Git

Expires:
24 hours
```

---

# 16. Connection Management

Create a Connections screen.

Example:

```text
Connections

MCP Endpoint
https://<tunnel>/mcp

Status
● Online

Authentication
● Enabled

Active Clients
1

[ Copy Connection Information ]
```

Eventually allow multiple clients/tokens.

Example:

```text
ChatGPT
Active
RW + Terminal

Claude
Active
Read Only
```

Do not hardcode client-specific behavior into the core MCP runtime.

---

# 17. Activity / Audit Log

The user should be able to see what the AI is doing.

Create an Activity screen.

Example:

```text
Activity

14:42:15    terminal_execute
            npm test
            exit: 0

14:41:33    terminal_execute
            rg "authenticate" src/

14:40:21    terminal_execute
            git status
```

Record:

- timestamp
- session/client
- workspace
- tool
- command
- duration
- exit code
- permission result

Be careful not to persist secrets from command output unnecessarily.

Support clearing logs.

Design for configurable retention.

---

# 18. Approval System

Architect for optional human approval.

Possible workspace modes:

```text
Autonomous

Ask before:
    file deletion
    package installation
    network access
    destructive commands

Read only
```

For the first implementation, at minimum ensure the architecture can support pending approval requests from an MCP tool call to the Web UI.

---

# 19. Network Access

Network access from the sandbox should be treated separately from filesystem/terminal access.

Default policy should be configurable.

Example:

```text
Network

[ ] Allow sandbox internet access
```

When disabled, commands inside the agent sandbox should not have unrestricted internet access where the sandbox implementation supports enforcing this.

This permission is independent of the tunnel itself.

The tunnel must still be able to communicate externally while the agent sandbox can remain network-restricted.

---

# 20. Local Configuration

Store non-sensitive local application state in a platform-appropriate MCP Code configuration directory.

Conceptually:

```text
~/.mcp-code/
    config.json
    workspaces.json
    sessions/
    logs/
```

Do not put secrets into ordinary JSON configuration.

Create abstractions for:

```text
ConfigStore
CredentialStore
WorkspaceStore
SessionStore
AuditStore
```

Do not tightly couple application logic to a particular storage implementation.

---

# 21. Daemon Lifecycle

The local runtime should behave like a daemon for the duration of the MCP Code session.

It should own:

```text
Web UI
MCP Server
Sandbox Manager
Tunnel Manager
Session Manager
Token Manager
Audit Logger
```

Running `mcp-code` again should discover the existing runtime rather than creating a duplicate.

Handle graceful shutdown.

On shutdown:

1. Stop accepting MCP requests.
2. Terminate running commands.
3. Stop tunnels.
4. Stop sandboxes.
5. Flush required state/logs.
6. Release ports/locks.
7. Exit cleanly.

Handle crashes and stale lock/PID files.

---

# 22. Suggested Internal Architecture

Use clean separation between modules.

Conceptually:

```text
mcp-code/
│
├── apps/
│   ├── cli/
│   └── web/
│
├── packages/
│   ├── daemon/
│   ├── mcp-server/
│   ├── sandbox/
│   ├── tunnel-manager/
│   ├── authentication/
│   ├── permissions/
│   ├── workspace/
│   ├── terminal/
│   ├── audit/
│   ├── config/
│   └── shared/
│
├── docs/
│
├── examples/
│
├── package.json
└── README.md
```

A monorepo architecture may be used if it improves maintainability.

Do not over-engineer unnecessarily, but maintain clear boundaries.

---

# 23. Technology

Prefer TypeScript for the primary application.

Use the official MCP TypeScript SDK where appropriate.

Choose a modern Web UI framework suitable for a local developer dashboard.

Keep dependencies reasonable.

The project should work well on:

```text
Linux
macOS
Windows
```

It is acceptable for sandbox capabilities to differ by OS initially, but design a common interface.

Example:

```ts
interface SandboxProvider {
    create(config: SandboxConfig): Promise<Sandbox>;
    start(id: string): Promise<void>;
    execute(id: string, command: Command): Promise<CommandResult>;
    stop(id: string): Promise<void>;
    destroy(id: string): Promise<void>;
}
```

---

# 24. Security Requirements

Treat the MCP endpoint as a potentially powerful remote-control interface.

Security is not optional.

At minimum protect against:

- path traversal
- symlink escape
- unauthorized MCP access
- weak/random tokens
- unrestricted host shell access
- accidental host filesystem exposure
- accidental credential exposure
- command processes surviving session termination
- tunnel URL exposure without authentication
- unrestricted Docker socket access
- duplicate daemon instances
- malicious workspace content
- oversized command output
- denial-of-service through long-running commands
- unsafe credential persistence

Do not assume that because the project is local/open source it is automatically safe.

The trust boundary is:

```text
Untrusted / semi-trusted AI client
              |
              v
        MCP Authentication
              |
              v
         Permissions
              |
              v
           Sandbox
              |
              v
         Workspace
```

Every layer must enforce its responsibility.

---

# 25. Workspace Isolation

Never implement workspace security using only:

```text
process.cwd()
```

or:

```text
cd /workspace
```

Those are convenience mechanisms, not security boundaries.

Workspace isolation must be enforced by the sandbox/OS layer.

The agent should see something conceptually like:

```text
/
├── workspace
├── usr
├── tmp
└── ...
```

while host directories remain unavailable.

---

# 26. Folder Selection

Because browsers cannot arbitrarily provide unrestricted filesystem paths in a portable way, implement folder selection through the local daemon/native backend.

The Web UI should request folder selection from the backend.

The backend can launch the platform-appropriate folder picker.

The selected path is returned to the local Web UI and registered as a workspace.

Never accept arbitrary remote folder paths without validation.

---

# 27. Status Dashboard

Dashboard example:

```text
MCP CODE

Runtime
● Running

Workspace
my-project
/home/user/projects/my-project

Sandbox
● Running

MCP Server
● Running

Remote Access
Cloudflare
● Connected

Authentication
● Enabled

Active Connections
1

Recent Activity
────────────────────────────────

14:42 npm test               ✓
14:41 rg "authenticate"      ✓
14:40 git status             ✓
```

Provide obvious controls for:

```text
Stop MCP
Stop Tunnel
Revoke Connections
Change Workspace
Open Activity
```

---

# 28. Local-Only Mode

Remote tunneling must never be mandatory.

MCP Code should work completely locally.

Support:

```text
Local MCP HTTP
```

and:

```text
stdio
```

where practical.

A user should be able to run MCP Code with:

```text
Tunnel: OFF
Internet: OFF
```

and still connect compatible local MCP clients.

---

# 29. Tunnel Provider Philosophy

Do not make the rest of the application aware of Cloudflare/ngrok/Tailscale-specific implementation details.

Core code should communicate with:

```text
TunnelManager
```

which communicates with:

```text
TunnelProvider
```

This should make community-created providers easy.

Eventually contributors should be able to implement:

```text
class MyTunnelProvider implements TunnelProvider
```

and register it without modifying MCP core logic.

---

# 30. Extensibility

Design MCP Code so future versions can support:

```text
filesystem tools
browser tools
database tools
Docker tools
language servers
code indexing
semantic search
GitHub integration
approval workflows
multiple workspaces
multiple agents
multiple simultaneous MCP clients
custom sandbox images
plugin system
custom tunnel providers
```

Do not implement all of these now.

Simply avoid architectural decisions that make them difficult later.

---

# 31. Initial MVP

Do NOT try to implement everything simultaneously.

Build the MVP in phases.

## Phase 1 — Runtime

Implement:

```text
mcp-code CLI
daemon lifecycle
local Web UI
single workspace selection
configuration persistence
```

## Phase 2 — Sandbox

Implement:

```text
workspace isolation
sandbox lifecycle
terminal execution
timeout
stdout/stderr
cancellation
```

## Phase 3 — MCP

Implement:

```text
MCP server
terminal_execute
workspace_info
terminal_status
terminal_cancel
local MCP connection
```

Verify an MCP-capable client can:

```text
inspect project
modify project
run tests
fix code
```

## Phase 4 — Security

Implement:

```text
permissions
token authentication
workspace validation
audit logs
process cleanup
security tests
```

## Phase 5 — Tunnel Manager

Implement the provider abstraction.

Start with ONE provider.

For example:

```text
Cloudflare Tunnel
```

Once the abstraction is proven, add:

```text
ngrok
Tailscale
SSH/custom
```

## Phase 6 — UX

Improve:

```text
dashboard
connection status
activity
token management
workspace management
provider configuration
errors
onboarding
```

---

# 32. Testing

Create automated tests for critical security and lifecycle behavior.

Test cases must include:

```text
workspace selection
workspace mount
command execution
command timeout
command cancellation
daemon duplicate prevention
daemon crash recovery
token validation
invalid token
expired token
revoked token
permission denial
path traversal
symlink escape
process cleanup
tunnel start/stop
provider failure
sandbox destruction
```

Security-sensitive tests should be treated as first-class tests.

---

# 33. Developer Experience

The repository should provide straightforward development commands.

Aim for something like:

```bash
npm install

npm run dev

npm run build

npm test

npm run lint
```

Document prerequisites clearly.

Avoid requiring external hosted MCP Code services for development or testing.

---

# 34. README

Create a professional README explaining:

## What MCP Code is

A local-first open-source MCP runtime that allows MCP-capable AI agents to safely work inside a user-selected local coding workspace.

## Quick Start

```bash
npx mcp-code
```

Then:

```text
1. Browser opens.
2. Select project folder.
3. Configure permissions.
4. Start MCP.
5. Optionally configure a tunnel.
6. Copy MCP connection information.
7. Connect an MCP-capable AI.
```

Explain clearly:

> MCP Code does not upload your project to an MCP Code server. Your workspace and command execution remain on your machine.

Also explain that third-party AI and tunnel providers may process data according to their own services and policies.

---

# 35. Important Product Principle

Do not build MCP Code as another AI chat application.

MCP Code does NOT need to own the model.

Its role is:

```text
AI Client
     |
     | MCP
     v
MCP Code
     |
     v
Local Development Environment
```

The AI client provides intelligence.

MCP Code provides controlled access to the user's development environment.

---

# 36. Final Product Experience

The intended experience should ultimately be:

```text
$ npx mcp-code
```

Browser opens.

The user selects:

```text
~/projects/my-project
```

The user chooses:

```text
Read/Write      ON
Terminal        ON
Git             ON
Network         OFF
```

The user selects:

```text
Remote Access → Cloudflare
```

and completes the provider's local authentication/configuration.

MCP Code starts the tunnel and displays:

```text
MCP Server
● Online

Workspace
my-project

Remote Access
● Connected

MCP Endpoint
https://<provider-generated-url>/mcp

Authentication
● Required

Token
mcpc_••••••••••••••

[ Copy Connection Details ]
```

The user connects that endpoint to an MCP-capable AI.

The AI can then:

```text
inspect files
understand the codebase
search the project
modify code
run commands
install dependencies when permitted
run tests
inspect failures
fix problems
use Git
verify its changes
```

while operating within the configured workspace and security boundaries.

---

# 37. Implementation Instructions for the Coding Agent

Before writing substantial code:

1. Inspect the repository if one already exists.
2. Research the current official MCP TypeScript SDK APIs rather than assuming outdated MCP APIs.
3. Determine the current MCP transport/auth requirements.
4. Create an architecture document.
5. Define the module boundaries and interfaces.
6. Define the threat model.
7. Define the MVP implementation sequence.
8. Then begin implementation.

Do not implement fake security controls.

If an OS-level restriction cannot actually be enforced, clearly document that limitation rather than presenting a UI toggle as a security boundary.

Prefer small, testable components.

After each major phase:

```text
build
lint
test
```

and fix failures before continuing.

For security-sensitive components, explain the security assumptions in comments and documentation.

The final repository should contain working code, not only mockups or architectural placeholders.

The first milestone is successful when:

> An MCP-capable AI can connect to MCP Code, access a user-selected project through an isolated local environment, inspect and modify that project, execute development commands, run tests, and return results without receiving unrestricted access to the user's host machine.