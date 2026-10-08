# Verification record

## Local Linux checks

The current implementation has passed:

- Build and type/syntax checks.
- 43 automated tests, with real Docker integration and no skips.
- Chromium dashboard workflows, including workspace resources, stable-address forms, connection diagnostics, OAuth client removal, and escaped diff content.
- Package installation, launcher singleton, assets, image build, and graceful shutdown.
- Live ngrok gateway, owner login, OAuth consent, official MCP SDK initialization and Docker file read, unapproved-workspace denial, token refresh, and revocation.
- Live ngrok stable-address restart with the same public address, followed by the same protocol checks.

Git review tests include staged/working/new files, a non-Git folder, untrusted Git configuration, and a host-secret symlink. Reviews execute only in read-only, network-disabled containers.

## Environment-dependent checks

The normal live Cloudflare quick-tunnel attempt reaches tunnel registration, but this machine's resolver returns ENOTFOUND for its generated hostname. Public DNS resolves that hostname. A separate explicit public-DNS fixture check is available; normal application DNS is never changed.

Named Cloudflare account/domain verification requires an existing locally managed tunnel, credentials file, and DNS route. Validation and CLI argument construction are automated; no account-backed named tunnel is claimed verified here.

GitHub Actions runs the desktop matrix on Ubuntu, Windows, and macOS with Node 22 and 24, plus mandatory Linux Docker integration. Check the latest commit's run for its result. The earlier Windows Node 24 package test exposed an insufficient fixed shutdown delay; the check now waits for lock removal within a bounded deadline.

No native Windows/macOS Docker Desktop runners were registered during this work. Hosted desktop checks do not substitute for those native Docker runs. Likewise, official SDK tests do not constitute a sign-in test in a particular AI product. Use the fixture procedure in remote-setup.md to verify the intended client without sharing real projects.
