# OAuth and remote owner access

## Connect an agent

1. Add the projects you want to share in Workspaces and set their permissions.
2. For a remote client, start Cloudflare or ngrok from its tab in Remote access. Use the displayed HTTPS `/mcp` address.
3. Configure your MCP client to use OAuth. It discovers `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`, registers its callback and starts authorization.
4. The browser opens the dashboard's approval page. For a public dashboard, sign in with an owner login code first. The approval request remains in the URL fragment during login.
5. Check the workspaces this agent may use, then choose **Allow selected workspaces**. All boxes begin unchecked. Choose **Deny access** to refuse the request.
6. The client receives a single-use authorization code at its registered callback and exchanges it with its PKCE verifier. Tokens never appear in the dashboard or redirect URL.

The agent sees only approved projects through `list_workspaces`. Tools that read or execute accept an optional `workspaceId` from that list. Without it, the first available approved workspace is used. Each command mounts exactly one project. The dashboard's active-workspace switch does not change an OAuth grant or cancel its jobs. Removing a workspace cancels only jobs in that workspace and removes it from every OAuth grant. Other approved workspaces remain accessible; removing the last approved workspace revokes the grant and its refresh token. Manual bearer tokens continue to follow the active workspace.

A grant captures each selected workspace's permission ceiling. Later reductions take effect immediately, while increasing workspace permissions cannot silently broaden an existing grant. Remove/revoke the connection and authorize again to approve new projects or expanded permissions. Connections lists the selected projects and lets the owner revoke a grant. Current workspace command approval mode still applies.

## One public address

Both native providers forward the gateway listener, normally port 7866. It serves:

| Path                                           | Access                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `/` and dashboard assets                       | Owner login                                                                 |
| `/api/*`                                       | Owner session and per-run CSRF header; `/api/bootstrap` needs owner session |
| `/owner/login`                                 | Valid one-time owner code                                                   |
| `/.well-known/oauth-*`                         | Public OAuth discovery                                                      |
| `/register`, `/authorize`, `/token`, `/revoke` | Standard OAuth validation and rate limits                                   |
| `/mcp` and `/bridge/*`                         | OAuth access token or manual bearer token                                   |

The internal dashboard listener remains on loopback. Public owner requests are authenticated before proxying to it. Owner cookies do not authenticate MCP tools, and agent tokens do not authorize management APIs. Stopping MCP cancels command work but keeps the owner dashboard reachable; **Stop tunnel** closes public access entirely.

In the local dashboard, choose **Remote access → Create remote login code** after starting a tunnel. Copy the one-time code and enter it at the public address. It expires after five minutes; the resulting owner session lasts eight hours. Codes and sessions are memory-only hashes, lost on daemon restart, and bound to the public origin. Sign out from the public Remote access page. Tunnel addresses can change between runs, requiring clients to authorize again for the new resource URL.

## Protocol and lifetime

- Authorization-code grant, PKCE S256 only; no implicit/password/client-credentials grant.
- Scope `mcp:access`; workspace selection is controlled by the owner, never by a requested scope or client parameter.
- The `resource` parameter must exactly match the current canonical MCP URL at authorization and token/refresh exchange.
- Dynamic client registration supports public `none` and confidential `client_secret_post` clients. Client secrets are returned once and stored as hashes. HTTPS callbacks and HTTP loopback callbacks are accepted; non-loopback callbacks require exact matching.
- Approval requests expire after five minutes; codes expire after sixty seconds and are single use.
- Access tokens last one hour. Refresh tokens rotate on each use, with a fixed thirty-day grant lifetime. Replay of a retained prior refresh token revokes the connection; the most recent 256 hashes are retained. Any older replay is still rejected as invalid.
- Access-token, refresh-token, and client-secret values are never written to local state. Registered client metadata, secret hashes and grant records persist across restart. Pending requests and authorization codes do not.

Client-ID metadata documents, pre-registered identity-provider accounts, OpenID Connect login, external identity federation and `private_key_jwt` authentication are not implemented. A client must support dynamic registration (or reuse its registered ID) and one of the supported authentication methods. This implementation has automated protocol and browser checks; a live third-party connector may impose additional requirements.

Reference: [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## Live verification

Run `npm run test:live:ngrok` or `npm run test:live:cloudflare` explicitly after installing/configuring that provider's native CLI and preparing the Docker sandbox image. These commands open a temporary public tunnel to a separate runtime containing harmless fixture projects. They check owner login, OAuth discovery/approval, the official MCP SDK client, an actual sandbox file read, unapproved-workspace denial, refresh and revocation. The temporary runtime, tunnel, and files are cleaned up afterward. No real workspace or existing app configuration is used. These network checks are opt-in and are not run by ordinary CI.

The ngrok check passed on this Linux host. This verifies the native tunnel and official SDK client; it is not a claim of successful sign-in in every third-party connector. Cloudflare live verification still requires its CLI on the testing host.

OAuth request limits apply per endpoint across the whole local runtime. Forwarded IP headers are not trusted for identifying clients or bypassing these limits.
