# MCP Code

**A local workspace runtime for MCP coding clients.**

MCP Code gives an MCP-capable AI client controlled access to a project on your computer. It can inspect files, modify code, execute development commands, and run tests inside an isolated Docker environment. The CLI launches a local dashboard; you manage projects, permissions, client tokens, approvals, and remote access there.

MCP Code does not upload your project to an MCP Code server. Your workspace and command execution remain on your machine. AI clients and third-party tunnel providers may process the data you share according to their own policies. MCP Code owns no hosted cloud service, relay, domain, or account system. Its OAuth authorization server runs in your local daemon.

## Run from this repository

Supported desktop hosts: **Windows, macOS, and Linux**. Requirements: Node.js 22 or later; a running Linux-container Docker engine (Docker Desktop on macOS/Windows); a browser. Native folder selection uses zenity or kdialog on Linux; macOS uses its native picker and Windows uses FolderBrowserDialog. You can also enter a validated local path in the dashboard.

```bash
npm install
npm run build
npm start
```

The dashboard opens at **http://localhost:7865**. Running the launcher again opens the same daemon. The launcher exits while the daemon remains available. Use Settings → Shut down MCP Code to stop it gracefully.

1. Add projects in Workspaces. Manual tokens use the active project; OAuth agents see only the projects you approve.
2. Build the development image from Dashboard or Settings. This one-time build downloads the base image and development tools. Alternatively run `npm run sandbox:build`.
3. Set workspace permissions and command approval mode.
4. Connect an OAuth-capable client and check its permitted workspaces on the approval page, or create a manual access token in Connections.
5. Add the MCP endpoint to your client. Manual-token clients also need the Authorization header.
6. Optionally start a Cloudflare or ngrok tunnel from Remote access.

The sandbox image includes Node.js, npm/npx, Python, pip, Git, ripgrep, make, compilers, curl and tree. Installed dependencies written into your project survive subsequent commands. `/tmp` and the sandbox home are ephemeral; use project-local virtual environments and dependencies. With network disabled, dependency downloads will fail by design.

## npm distribution

The package includes the `mcp-code` and `mcp-code-stdio` executables and is ready for a maintainer to publish. **This source distribution has not been published to the npm registry.** After publication, users can run:

```bash
npx mcp-code
# or
npm install -g mcp-code
mcp-code
```

Until then, use the source commands above or install a locally packed tarball. Do not assume the current registry package with that name belongs to this repository.

```bash
npm pack
npm install -g ./mcp-code-0.1.0.tgz
```

## Connect a client

### Streamable HTTP

The default local endpoint is `http://127.0.0.1:7866/mcp`. Authenticated tool requests require an OAuth access token or a manual token:

```http
Authorization: Bearer mcpc_<your-token>
```

OAuth clients discover the authorization server from the MCP endpoint and use the browser approval flow. Check the workspaces the agent may access, then choose **Allow selected workspaces**. The agent can use `list_workspaces` and pass `workspaceId` to workspace tools. See [OAuth and owner login](docs/oauth.md). For clients supporting manual bearer headers, the official MCP TypeScript SDK client works:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-client', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://127.0.0.1:7866/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_CODE_TOKEN}` } },
  }),
);
console.log(await client.callTool({ name: 'workspace_info', arguments: {} }));
```

### stdio

Start the dashboard daemon first, select a workspace, and create a token. For a globally installed package, configure your MCP client with:

```json
{
  "mcpServers": {
    "mcp-code": {
      "command": "mcp-code-stdio",
      "env": { "MCP_CODE_TOKEN": "mcpc_<your-token>" }
    }
  }
}
```

For a source checkout, use `node` as the command and the absolute path to `dist/apps/cli/stdio.js` as its argument. Store the token in your client's secure configuration; do not commit it. The stdio bridge uses the same daemon, policies and containers, and logs diagnostics only to stderr.

### Tools

| Tool               | Purpose                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| `list_workspaces`  | Approved project IDs, names, and permissions                           |
| `workspace_info`   | Chosen project identity, `/workspace`, and effective permissions       |
| `terminal_execute` | Sandboxed shell command with timeout, cwd, and optional background job |
| `terminal_status`  | Your job state and bounded stdout/stderr                               |
| `terminal_cancel`  | Terminate your job and its container                                   |
| `read_file`        | Bounded UTF-8 file slice, including read-only clients                  |
| `directory_tree`   | Bounded tree without following symlinks                                |
| `search_text`      | Literal text search with bounded output                                |

```json
{ "command": "npm test", "timeout": 120000, "cwd": "/workspace", "background": false }
```

Normal terminal calls return `id`, `exitCode`, `stdout`, `stderr`, `duration`, `truncated`, `timedOut`, and `cancelled`. Background and approval-mode calls return a job record; poll with `terminal_status`. Timeout is capped at five minutes, output at 256 KiB, and concurrent commands at eight overall / three per client. Completed output stays in memory, bounded to 100 jobs, and is discarded on restart. Stateless HTTP accepts POST; a persistent SSE session is not required.

## Permissions and approvals

Access is the intersection of the chosen workspace policy and the token or OAuth consent policy. Manual tokens are scoped to one active project and can be rotated. OAuth grants cover only the projects checked during consent, retain their permission ceilings, and can be revoked in Connections. Switching the active project affects manual tokens; it does not expand an OAuth grant. Removing a project removes access to it.

Arbitrary terminal execution requires **Read + Modify + Execute + Git**. A shell cannot reliably enforce selective Git or write restrictions through command filtering, so disabling any of these disables the terminal tool. Read-only clients retain the structured read tools, which run fixed code through read-only containers. Network permission is separate and enforced through Docker's network mode. It defaults to off.

Approval mode asks before **every terminal command**, with exact command text visible in Dashboard and Activity. Requests expire after two minutes. Structured reads do not require approval. Policy changes, revocation, workspace switching and stopping MCP cancel affected commands.

## Isolation

Each command runs in a fresh, non-root Docker container with:

- Only the selected project bound at `/workspace`; no host home or Docker socket.
- A read-only system filesystem and ephemeral `/tmp` and home.
- All Linux capabilities dropped and no-new-privileges enabled.
- 512 MiB memory, one CPU, and 128-process limits.
- Network disabled unless both workspace and token grant it.
- Forced container removal on timeout/cancel and cleanup after normal exit.

The daemon refuses to substitute an unrestricted host shell when Docker is unavailable. Absolute host symlinks inside the project cannot expose host files because they resolve within the container. Structured tools additionally reject paths outside `/workspace`. Workspace roots and user-controlled parents must not be symlinks or junctions. macOS built-in system path aliases are validated separately. The running MCP Code installation and its containing folders are protected from workspace selection, preventing clients from rewriting the trusted dashboard or daemon. To work on MCP Code itself, run a separately installed package and select the source checkout.

Containers share their Docker engine's Linux kernel. Docker Desktop runs that engine inside a Linux VM; individual containers are not separate virtual machines. Keep Docker and your OS patched, consider rootless Docker, and select a project without secrets or nested host mounts. Enabling network permits access to reachable local-network services. See [the threat model](docs/security.md) for assumptions and limitations. The application targets Windows, macOS, and Linux, using a Linux command sandbox on every host. Configured cross-platform CI checks the daemon, dashboard, and packaged launcher; a separate native Docker Desktop workflow is provided. This development machine verifies real execution on Linux; native Windows/macOS results must be checked on their runners. See [platform support and setup](docs/platforms.md).

## Remote access

Install the official `cloudflared` CLI and choose Remote access → Cloudflare → Start Cloudflare quick tunnel. MCP Code runs a native quick tunnel, reads its generated HTTPS URL, and displays the actual `/mcp` endpoint. No provider credentials are required for quick tunnels. One public address serves the owner-protected dashboard at `/`, OAuth endpoints, and authenticated MCP at `/mcp`. The gateway forwards authorized owner dashboard requests to its separate loopback UI service. In the local Remote access page, generate a one-time owner login code before opening the public dashboard. OAuth agents never receive dashboard access. Stopping the tunnel does not enable or disable sandbox internet access.

For ngrok, install its native CLI on Windows, macOS, or Linux, then configure it once in your terminal with `ngrok config add-authtoken YOUR_TOKEN`. Choose Remote access → ngrok → Start ngrok. MCP Code reads the actual HTTPS endpoint from JSON startup logs and forwards only the MCP port. HTTP inspection is disabled. Account credentials remain in ngrok's native configuration, separate from MCP bearer tokens. If you configure ngrok to disable its local agent web interface (`web_addr: false`), URL discovery still works. See the [official ngrok CLI guide](https://ngrok.com/docs/gateway/agent/cli).

This release includes **Cloudflare and ngrok**. Tailscale, SSH and custom providers can implement the [TunnelProvider interface](packages/tunnel-manager/provider.ts) and register with TunnelManager. No hosted MCP Code infrastructure is needed. Provider failures and unexpected process exits are shown in the dashboard.

## Local state

Non-sensitive state, token hashes, audit metadata, daemon discovery and runtime logs are stored in:

| Platform | Default directory                                   |
| -------- | --------------------------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/mcp-code` or `~/.config/mcp-code` |
| macOS    | `~/Library/Application Support/mcp-code`            |
| Windows  | `%LOCALAPPDATA%/mcp-code`                           |

The local state file is written atomically with owner-only Unix modes; on Windows it inherits the current user's Local AppData ACLs. Raw access tokens are never saved. Credentials for future tunnel adapters must stay with native authentication or a configured OS keychain adapter; there is no plaintext credential fallback. Audit history records commands but not their stdout/stderr, is bounded to 1,000 entries, and defaults to seven-day retention. Commands may themselves contain secrets; avoid credentials in command text and clear history when needed.

`MCP_CODE_HOME` overrides the state directory for development/testing; `MCP_CODE_NO_BROWSER=1` suppresses automatic browser opening. Normal user configuration lives in the Web UI, not command-line flags. Ports and retention are configurable in Settings; ports apply on the next restart.

## Development and verification

```bash
npm run dev          # launch source with tsx
npm run build        # compile TypeScript
npm run lint         # strict typecheck and dashboard syntax check
npm test             # core/platform + real Docker/MCP security and lifecycle tests
npm run test:ui      # Chromium dashboard workflow and responsive checks
npm run test:package # install and smoke-test the local tarball
npm run verify      # build, lint, core/integration and browser checks
npm run format       # format source and documentation
```

`npm test` explicitly skips container integration when Docker or the image is unavailable; it never reports a mock as proof of isolation. Build the image to run those checks. Browser tests need Chromium (`npx playwright install chromium`), a compatible installed Google Chrome, or `MCP_CODE_CHROME` pointing to its executable.

Integration coverage includes the official HTTP and stdio clients, a real read/edit/test/fix workflow, read-only access, token invalidation, approval, malicious Host/Origin, traversal/symlink escape, no socket/secrets/network access, timeout, bounded output, cancellation of child processes, duplicate prevention, crash leftovers, and cleanup. Tests create disposable project folders and remove only their own labeled containers.

## Project layout

```text
apps/cli/          launcher and stdio executable
apps/web/          dashboard (native browser modules; no CDN or hosted fonts)
packages/          daemon, MCP, sandbox, terminal, auth, policy, workspace,
                   local storage, audit and tunnel modules
tests/             core, container/MCP integration and browser workflows
docs/              architecture, threat model and provider extension guide
examples/          client connection example
Dockerfile.sandbox isolated development image
```

The small dashboard uses native browser modules to keep installation and packaging self-contained. Backend module interfaces separate sandboxing, storage, workspace policy, and providers. See [architecture](docs/architecture.md) and [extension guide](docs/providers.md).

## License

MIT. See [LICENSE](LICENSE).
