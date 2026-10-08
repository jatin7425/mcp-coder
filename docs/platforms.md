# Desktop operating systems

MCP Code targets **Windows, macOS, and Linux**. The same npm package, dashboard, MCP transports, token policy, approvals, and audit features are used on each host. Node.js 22+ is required.

| Host    | Isolated command environment          | Folder selection                                      | Default local state                                 |
| ------- | ------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| Linux   | Linux Docker Engine or Docker Desktop | zenity/kdialog, with manual-path fallback             | `$XDG_CONFIG_HOME/mcp-code` or `~/.config/mcp-code` |
| macOS   | Docker Desktop, Linux containers      | Native Finder dialog through osascript                | `~/Library/Application Support/mcp-code`            |
| Windows | Docker Desktop, Linux-container mode  | Native FolderBrowserDialog through desktop PowerShell | `%LOCALAPPDATA%/mcp-code`                           |

Commands run in a **Linux development container on every host**, not an unrestricted native host shell. Windows PowerShell/CMD commands, macOS-only tools such as Xcode, Windows executables, and host drivers are not provided by this sandbox. A project needing native OS build tools requires a future native VM sandbox provider. This limitation does not change the host's dashboard or MCP connectivity.

## Setup

On each platform, install Node.js and a local Docker engine, then use the same commands:

```text
npm install
npm run build
npm start
```

For a packed distribution, install `mcp-code-0.1.0.tgz` with npm and run `mcp-code`. npm creates the appropriate Windows command shim automatically. The package smoke test invokes npm's JavaScript entry point through Node, so it does not rely on executing a `.cmd` file through `execFile`.

On Windows, switch Docker Desktop to **Linux containers**, and allow the selected project drive/folder to be shared. Local drive paths with spaces and Unicode are supported; network/UNC shares are rejected. On macOS, grant Docker Desktop access to the selected project folder when requested. The daemon reports a wrong container-engine mode and never falls back to host command execution.

Docker Desktop file sharing maps the host workspace into its Linux VM. Containers use UID/GID 1000 on Windows; Linux and macOS use the current non-root host UID/GID so Unix bind-mount permissions are preserved. Git trusts only `/workspace` to avoid ownership mismatches caused by Desktop file sharing. All capabilities remain dropped and the root filesystem stays read-only.

Windows paths are compared without case sensitivity and with drive boundaries preserved. Symlinks and junctions remain rejected as workspace roots or parents. macOS's exact built-in `/var` → `/private/var`, `/tmp` → `/private/tmp`, and `/etc` → `/private/etc` aliases are permitted as parent aliases; arbitrary user-created links remain rejected. Protected configuration paths are canonicalized before comparison. macOS protection of system/application trees conservatively rejects case variants on either volume type.

Daemon leases use Linux boot/start identities, macOS process start/name identities, or Windows process start ticks to distinguish stale/reused PIDs. If a live process identity cannot be verified, the lock is retained rather than stolen. Background CLI processes hide additional console windows on Windows. The Windows folder picker writes UTF-8, preserving non-ASCII paths.

Unix state files use owner-only modes. Windows mode bits do not provide Unix-style ACL enforcement: the default state directory lives in the current user's Local AppData and inherits its Windows ACLs. Keep any custom `MCP_CODE_HOME` private to that user; do not point it at a shared folder. Raw tokens are not stored on any platform.

## Verification

`.github/workflows/ci.yml` checks build, types, core/platform tests, browser workflows, and packed launcher lifecycle on Windows, macOS, and Linux, with Node 22 and 24. Hosted Windows/macOS CI does not provide a configured Linux-container Docker Desktop engine; those jobs explicitly skip Docker execution when unavailable. A separate mandatory Linux security job builds the real image and fails if Docker integration is skipped.

`.github/workflows/desktop-docker.yml` provides manual native Windows/macOS Docker Desktop verification. Register a trusted self-hosted desktop runner with its OS label (`Windows` or `macOS`) and `mcp-code-desktop`; keep Docker Desktop running in Linux-container mode, then dispatch this workflow. It is manual-only and does not run untrusted pull-request code on your desktop. Alternatively run locally:

```text
npm run sandbox:build
npm run verify
npm run test:package
```

Set `MCP_CODE_REQUIRE_DOCKER=1` in the host's environment to make missing Docker/image prerequisites fail rather than skip integration. This is useful for release verification.

The development machine for this change is Linux: its real Docker/MCP and browser tests are run locally, along with platform-independent tests of Windows/macOS path policy and container arguments. Native Windows/macOS CI workflows are provided but their results cannot be claimed until run on those hosts. Android, iOS, obsolete desktop releases, and operating systems without a compatible Node.js and Docker environment are not supported local runtime hosts.

References: [Docker Desktop settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/), [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/), [Node child processes](https://nodejs.org/api/child_process.html), [Playwright CI](https://playwright.dev/docs/ci).
