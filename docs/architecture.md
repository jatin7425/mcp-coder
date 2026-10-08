# Architecture and implementation sequence

MCP Code is a TypeScript local daemon, with a static responsive dashboard and the official MCP SDK 1.32.1. It owns two loopback listeners: management/UI (7865) and MCP (7866). The MCP listener also acts as the public gateway: one tunnel serves the owner-authenticated dashboard, OAuth routes, and MCP. Owner UI requests are proxied to the internal management listener. Streamable HTTP uses a fresh stateless transport per request; sessions are explicit application command/client records, not bearer capabilities. The separate stdio executable proxies the same tools through the authenticated daemon using an environment-supplied token. Normal configuration happens in the dashboard.

## Boundaries

- config: atomic JSON persistence, filesystem permissions, daemon lease.
- workspace: canonical folder validation and native selection, independent workspace policies.
- authentication: manual tokens, OAuth authorization-code/PKCE flow, hashed client/access/refresh secrets, refresh rotation, per-client workspace consent and owner sessions.
- permissions: effective intersection of workspace and token policy; terminal capability requirements.
- sandbox: Docker provider, ephemeral command containers, read-only system, only selected workspace bind mount, no Docker socket, capabilities, network or host secrets.
- terminal: bounded output, timeouts, asynchronous jobs, cancellation and ownership, approval queue.
- audit: metadata-only bounded retention and clearing.
- tunnel-manager: provider interface and Cloudflare and ngrok native CLI adapters, actual URL discovery.
- mcp-server: terminal and structured file tools registered through SDK, authenticated requests, request limits.
- daemon: routing, state, lifecycle and service orchestration.

Storage interfaces permit replacing local JSON; provider interfaces permit additional sandbox and tunnel backends. A built-in hashed token store needs no raw secret credential persistence. Tunnel credentials stay in the provider's native credential store. A credential-store interface is supplied for future authenticated adapters; no plaintext fallback.

## Execution semantics

Containers are created per command with a unique name, runtime label, workspace-configured CPU and RAM limits (1 CPU and 512 MiB by default), 128 process limit, no capabilities, no-new-privileges, a read-only root, writable ephemeral /tmp and /home/agent, and only /workspace mounted. Network defaults to none. Commands use the host user's non-root UID/GID on Linux/macOS and UID/GID 1000 on Windows; Docker Desktop is supported subject to its file sharing permissions. Timeout/cancel forcibly destroys the container, including background descendants. Container names are persisted before launch; crash recovery removes only this installation's labeled containers. A built-in image includes Node, npm, Python, pip, Git, make and ripgrep; the UI can build it explicitly.

Arbitrary shell commands cannot honestly enforce selective Git access or distinguish reads from writes. Accordingly terminal execution requires read, write, execute and Git permissions together. Disabling any of these disables arbitrary terminal execution. Read-only clients can use structured read_file, search_text and directory_tree tools through read-only containers. Network is independently enforced by Docker. Permission edits, token revocation, workspace deactivation and runtime stop cancel affected jobs. Symlinks inside /workspace resolve within the container, never into host directories outside the mount. Structured tools additionally canonicalize paths inside the container.

## Sequence

1. launcher, singleton lease, configuration, dashboard and workspace selection;
2. isolated execution and jobs;
3. HTTP/stdio MCP and tools;
4. permissions, auth, approvals, audit and security tests;
5. provider abstraction and Cloudflare/ngrok tunnels;
6. user experience, real MCP integration, container security/lifecycle tests, packaging.

Research: https://ts.sdk.modelcontextprotocol.io/server ; https://modelcontextprotocol.io/specification/2025-11-25/basic/transports ; https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization . The installed SDK examples are the implementation authority. This release supports manual bearer tokens and OAuth with protected-resource discovery, dynamic client registration and S256 PKCE. OAuth grants bind a client, resource URL, and selected workspaces; clients use workspaceId to choose among approved projects. Client-ID metadata documents and external identity providers are not implemented. There is no claim of universal client compatibility.

Platform behavior and CI coverage are documented in [platforms.md](platforms.md). Host path comparisons, system aliases, storage locations, process identities and native folder selection are OS-aware; sandbox paths remain POSIX because the execution environment is Linux on all desktop hosts.
