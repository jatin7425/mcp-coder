import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
if (!process.env.MCP_CODE_TOKEN) throw new Error('Set MCP_CODE_TOKEN to a dashboard-issued token.');
const client = new Client({ name: 'mcp-code-example', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_CODE_ENDPOINT || 'http://127.0.0.1:7866/mcp'), { requestInit: { headers: { authorization: `Bearer ${process.env.MCP_CODE_TOKEN}` } } }));
try {
  console.log(await client.callTool({ name: 'workspace_info', arguments: {} }));
  console.log(await client.callTool({ name: 'directory_tree', arguments: { depth: 2 } }));
} finally { await client.close(); }
