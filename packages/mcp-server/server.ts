import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import type { Principal } from '../shared/types.js';
import { descriptions, toolSchemas, type ToolName, type ToolService } from './tools.js';
export function createMcpServer(service: ToolService, principal: Principal) {
  const server = new McpServer(
    { name: 'mcp-code', version: '0.1.0' },
    { maxToolInputElements: 100 },
  );
  for (const name of Object.keys(toolSchemas) as ToolName[]) {
    server.registerTool(
      name,
      {
        description: descriptions[name],
        inputSchema: toolSchemas[name].shape,
        annotations: {
          readOnlyHint: [
            'list_workspaces',
            'workspace_info',
            'read_file',
            'directory_tree',
            'search_text',
            'terminal_status',
          ].includes(name),
          openWorldHint: name === 'terminal_execute',
        },
      },
      async (args: unknown, extra: { signal: AbortSignal }) =>
        service.result(name, args, principal, extra.signal),
    );
  }
  return server;
}
export async function serveMcp(
  req: Request,
  res: Response,
  service: ToolService,
  principal: Principal,
) {
  const server = createMcpServer(service, principal);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.once('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
