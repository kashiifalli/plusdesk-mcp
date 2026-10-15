import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'peek', version: '0' });
await c.connect(new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/index.ts'] }));
const [name, args] = [process.argv[2], JSON.parse(process.argv[3] ?? '{}')];
const r: any = await c.callTool({ name, arguments: args });
console.log(r.content[0].text.slice(0, Number(process.argv[4] ?? 3000)));
await c.close();
