#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configDirectory } from '../../packages/config/store.js';
import { readDaemon } from '../../packages/config/lease.js';
import { toolSchemas, descriptions, type ToolName } from '../../packages/mcp-server/tools.js';
import { message } from '../../packages/shared/types.js';
async function main() {
  const token = process.env.MCP_CODE_TOKEN;
  if (!token)
    throw new Error(
      'Set MCP_CODE_TOKEN to a dashboard-created access token. Start mcp-code first.',
    );
  const info = await readDaemon(configDirectory());
  if (!info) throw new Error('Start mcp-code and select a workspace first.');
  const server = new McpServer({ name: 'mcp-code', version: '0.1.0' });
  const controller = new AbortController();
  const jobs = new Set<string>();
  for (const name of Object.keys(toolSchemas) as ToolName[])
    server.registerTool(
      name,
      { description: descriptions[name], inputSchema: toolSchemas[name].shape },
      async (args: unknown) => {
        try {
          const response = await fetch(`http://127.0.0.1:${info.mcpPort}/bridge/${name}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(args),
            signal: controller.signal,
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Local runtime request failed.');
          if (name === 'terminal_execute' && result.structuredContent?.id)
            jobs.add(result.structuredContent.id);
          return result;
        } catch (error) {
          return { isError: true, content: [{ type: 'text' as const, text: message(error) }] };
        }
      },
    );
  const stop = async () => {
    controller.abort();
    await Promise.allSettled(
      [...jobs].map((id) =>
        fetch(`http://127.0.0.1:${info.mcpPort}/bridge/terminal_cancel`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ id }),
          signal: AbortSignal.timeout(5000),
        }),
      ),
    );
    await server.close();
  };
  process.stdin.once('end', () => {
    void stop().then(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    void stop().then(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void stop().then(() => process.exit(0));
  });
  await server.connect(new StdioServerTransport());
}
main().catch((error) => {
  console.error(message(error));
  process.exitCode = 1;
});
