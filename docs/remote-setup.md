# Stable tunnel addresses

Start with Remote access → Check connections. Docker and the development image are needed for tools and change review, while a native tunnel CLI is needed for remote access. Checks report installation/configuration readiness; credentials, DNS, and account entitlements are validated by a real connection.

## ngrok

Configure the native ngrok CLI once with your account token. In the ngrok tab, stop any active tunnel, choose Configure address → Stable address, and enter an HTTPS domain available in your ngrok account. Save and start ngrok. The app passes the configured URL to ngrok and accepts only a matching endpoint-start event. All routes use the same gateway port. HTTP inspection stays disabled.

For temporary fixture verification, run `npm run test:live:ngrok -- --stable`. It starts a provider-assigned endpoint, saves that address, reconnects using the explicit address, and checks owner login, OAuth, MCP access, refresh, and revocation. The test needs permission to reuse that domain in the configured account.

Reference: [ngrok agent CLI](https://ngrok.com/docs/agent/cli/).

## Cloudflare

Use a **locally managed** named tunnel with a native JSON credentials file. Create the tunnel and DNS route through Cloudflare's native setup first. In the Cloudflare tab, choose Configure address → Stable address, and provide:

- The tunnel UUID.
- The absolute path to its native credentials JSON file.
- Its routed HTTPS hostname, without `/mcp` or other paths.

The app starts this tunnel against the current loopback gateway port. It supplies an isolated temporary configuration rather than loading unrelated native ingress rules. It reports the configured address after the CLI registers a connection. A registered connection alone does not establish that DNS routing is correct; verify the public dashboard and client authorization afterward. Remote-managed token-only tunnels are not supported by this form.

To return to a quick tunnel, choose Provider-assigned address. Quick tunnel hostnames change. The live check `npm run test:live:cloudflare` uses temporary fixture projects and removes its tunnel afterward. If the host resolver blocks provider domains, the explicit test-only `-- --public-dns` option resolves that fixture hostname through Google public DNS; it never changes system or application DNS. A pass with this option does not prove the host’s normal DNS path works.

Reference: [Cloudflare locally managed setup](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/).

## Verify your AI client

Use the displayed `/mcp` URL in the intended MCP-capable client. Start its OAuth flow, sign in to the owner dashboard, select one fixture workspace, and approve. Verify a file read succeeds in that workspace, an unselected workspace is denied, and revoking the grant disables future calls. The official SDK checks exercise the protocol but do not prove compatibility with every product's connector UI or account restrictions.

A changed hostname changes the OAuth resource identifier. Reauthorize clients after changing it. Stable addresses need the native provider's account/domain configuration and working DNS; entering a URL alone cannot provision those resources.
