#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, open as openFile } from 'node:fs/promises';
import { join } from 'node:path';
import open from 'open';
import { configDirectory } from '../../packages/config/store.js';
import { readDaemon } from '../../packages/config/lease.js';
import { startRuntime } from '../../packages/daemon/runtime.js';
import { message } from '../../packages/shared/types.js';
const directory = configDirectory();
async function discover() {
  const info = await readDaemon(directory);
  if (!info) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${info.uiPort}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    const body = await response.json();
    if (body.name === 'mcp-code' && body.instance === info.instance && !body.stopping) return info;
  } catch {}
  return undefined;
}
async function launch() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      'MCP Code — local sandboxed coding over MCP\n\n  mcp-code           Start runtime and open dashboard\n  mcp-code-stdio     Connect a local stdio client (MCP_CODE_TOKEN required)\n\nAll workspace, permission and connection configuration happens in the dashboard.',
    );
    return;
  }
  if (process.argv.includes('--internal-daemon')) {
    const runtime = await startRuntime(directory);
    console.log(`MCP Code running at http://localhost:${runtime.info.uiPort}`);
    const stop = () => {
      void runtime.stop().then(
        () => process.exit(0),
        (error) => {
          console.error(message(error));
          process.exit(1);
        },
      );
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('uncaughtException', (error) => {
      console.error(message(error));
      stop();
    });
    process.on('unhandledRejection', (error) => {
      console.error(message(error));
      stop();
    });
    return;
  }
  if (process.argv.length > 2)
    throw new Error('Configure MCP Code in the dashboard. Run mcp-code without arguments.');
  let info = await discover();
  if (info) console.log('MCP Code is already running.');
  else {
    console.log('Starting MCP Code...');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const log = await openFile(join(directory, 'runtime.log'), 'a', 0o600);
    const child = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1], '--internal-daemon'],
      {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
        env: { ...process.env, MCP_CODE_DAEMON_CHILD: '1' },
      },
    );
    child.unref();
    await log.close();
    for (let i = 0; i < 150; i++) {
      info = await discover();
      if (info) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!info) throw new Error(`Runtime failed to start. Check ${join(directory, 'runtime.log')}.`);
    console.log('✓ Runtime started\n✓ Web UI started');
  }
  const url = `http://localhost:${info.uiPort}`;
  console.log(`Opening ${url}`);
  if (!process.env.MCP_CODE_NO_BROWSER)
    await open(url).catch(() => console.log(`Open ${url} in your browser.`));
}
launch().catch((error) => {
  console.error(message(error));
  process.exitCode = 1;
});
