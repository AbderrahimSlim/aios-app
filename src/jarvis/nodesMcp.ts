/* The `aios-nodes` MCP server (stdio), loaded by Jarvis's session only (its workspace mcp.json).

   It gives Claude the "hands": `nodes_list` (machines online and what each can do) and `node_call`
   (ask a machine to perform ONE declared capability). It holds no power of its own: every call goes to
   the host's loopback-only /internal/nodes API, which validates the arguments against the capability's
   schema and routes the request (RFC §5.5). The guard hook pauses these tools for 5 minutes after outside
   content was read, and the node itself asks the operator to confirm anything with a side effect. */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const PORT = Number(process.env.AIOS_HOST_PORT || 4800);
const TOKEN_FILE = String(process.env.AIOS_INTERNAL_TOKEN_FILE || '');

function host(body: unknown, timeoutMs = 150_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let token = '';
    try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { reject(new Error(`no internal token: ${String(e)}`)); return; }
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/internal/nodes', method: 'POST', timeout: timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-AIOS-Internal': token } }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { out += d; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error(`host answered ${res.statusCode}`)); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('host timeout')));
    req.end(data);
  });
}

const TOOLS = [
  {
    name: 'nodes_list',
    description: "Lists the machines (nodes) online and the capabilities each one offers, with their argument schemas. Call it before node_call when unsure which capability or machine to use.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'node_call',
    description: "Asks a machine to perform ONE declared capability (e.g. volume.set {level: 30}). Without `target`, it goes to the machine the operator is speaking from (or the only node online). The node may ask the operator to confirm on its screen. Returns the result or why it failed.",
    inputSchema: {
      type: 'object',
      properties: {
        capability: { type: 'string', description: 'Capability name from nodes_list, e.g. "volume.set".' },
        args: { type: 'object', description: "Arguments matching the capability's schema." },
        target: { type: 'string', description: 'Optional machine name or node id.' },
      },
      required: ['capability'],
      additionalProperties: false,
    },
  },
];

async function callTool(name: string, args: Record<string, any>): Promise<{ text: string; isError: boolean }> {
  if (name === 'nodes_list') {
    const r = await host({ op: 'list' });
    if (!r.nodes?.length) return { text: 'Aucun nœud en ligne.', isError: false };
    const lines = r.nodes.map((n: any) => `${n.machine} (id ${n.id})${n.machine === r.activeMachine ? ' — appareil actif' : ''}:\n` +
      n.capabilities.map((c: any) => `  - ${c.name}${c.confirm ? ' [confirmation]' : ''}: ${c.description} ${JSON.stringify(c.schema?.properties || {})}`).join('\n'));
    return { text: lines.join('\n'), isError: false };
  }
  if (name === 'node_call') {
    const r = await host({ op: 'call', capability: String(args.capability || ''), args: args.args && typeof args.args === 'object' ? args.args : {}, target: args.target });
    /* A screen capture is saved in the vault (where the session can Read it as an image), never inlined. */
    if (r.ok && r.value && typeof r.value.png_base64 === 'string' && process.env.AIOS_SCREENS_DIR) {
      const dir = process.env.AIOS_SCREENS_DIR;
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const who = String(r.node || 'node').replace(/[^A-Za-z0-9_-]/g, '_');
      const file = path.join(dir, `${stamp}-${who}.png`);
      fs.writeFileSync(file, Buffer.from(r.value.png_base64, 'base64'));
      r.value = { image: file, width: r.value.width, height: r.value.height };
    }
    if (r.ok) return { text: `OK (${r.node || '?'}) : ${typeof r.value === 'string' ? r.value : JSON.stringify(r.value ?? null)}`.slice(0, 20_000), isError: false };
    return { text: `Échec [${r.state}] ${r.node ? `(${r.node}) ` : ''}: ${r.error}`, isError: true };
  }
  return { text: `unknown tool ${name}`, isError: true };
}

function send(m: unknown): void { process.stdout.write(JSON.stringify(m) + '\n'); }

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue;                       // notifications (initialized, cancelled)
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'aios-nodes', version: '1.0.0' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
    else if (m.method === 'tools/call') {
      callTool(String(m.params?.name), m.params?.arguments || {})
        .then((r) => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r.text }], isError: r.isError } }))
        .catch((e) => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `Hôte injoignable : ${String(e.message || e)}` }], isError: true } }));
    } else if (m.method === 'ping') send({ jsonrpc: '2.0', id: m.id, result: {} });
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
});
