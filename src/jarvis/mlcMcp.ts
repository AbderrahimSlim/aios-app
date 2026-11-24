/* The `mylittlecrm` MCP server (stdio) for Jarvis: READ-ONLY access to the operator's bookkeeping app
   (MyLittleCRM, a local Fastify API on 127.0.0.1). One tool, `crm_get`, limited to an allowlist of GET
   routes; no POST/PUT/DELETE exists here, so Jarvis cannot change accounting data. Exports and the FEC
   (large, sensitive dumps) are left out. Money in the API is integer CENTS. */
import * as http from 'node:http';

const BASE = new URL(process.env.MLC_URL || 'http://127.0.0.1:3001/api');
const MAX_CHARS = 24_000;

/** GET routes Jarvis may read (`:id` segments match one path segment). */
const ALLOW = [
  'dashboard', 'anomalies', 'accounts', 'statements', 'imports', 'backup/status', 'rules',
  'tax/vat', 'tax/bnc', 'tax/income', 'tax/households', 'tax/households/:id', 'tax/payslip-income', 'tax/params/:id',
  'accounting/exercises', 'accounting/balance', 'accounting/comparison', 'accounting/journal', 'accounting/ledger',
  'accounting/chart', 'accounting/assets', 'accounting/allocations', 'accounting/manual-entries', 'accounting/transactions/:id',
  'crm/periods', 'crm/expenses', 'crm/sales', 'crm/mileage', 'crm/mixed-charges',
  'receipts/statuses', 'receipts/transactions/:id',
];

export function allowed(route: string): boolean {
  const segs = route.replace(/^\/+|\/+$/g, '').split('/');
  if (segs.some((s) => !s || s === '..' || s === '.' || !/^[A-Za-z0-9_.-]+$/.test(s))) return false;
  return ALLOW.some((a) => {
    const as = a.split('/');
    return as.length === segs.length && as.every((x, i) => x === ':id' || x === segs[i]);
  });
}

function get(route: string, query: Record<string, unknown>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE.toString().replace(/\/?$/, '/') + route.replace(/^\/+/, ''));
    for (const [k, v] of Object.entries(query || {})) {
      if (/^[A-Za-z0-9_]{1,40}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)) u.searchParams.set(k, String(v).slice(0, 100));
    }
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') { reject(new Error('MyLittleCRM must be on this machine')); return; }
    const req = http.get(u, { timeout: 30_000 }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { out += d; if (out.length > 2_000_000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: out }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

const TOOLS = [{
  name: 'crm_get',
  description: "Reads the operator's bookkeeping (MyLittleCRM, French SASU: VAT CA3, BNC, income tax, bank, expense reports). "
    + 'READ-ONLY. Amounts are integer CENTS (divide by 100 for euros); rates are basis points (2000 = 20 %). '
    + 'Most tax/accounting routes need a `year` (e.g. {"year": 2026}). Useful routes: dashboard, anomalies, tax/vat, tax/bnc, '
    + 'tax/income, crm/periods, crm/expenses, accounting/balance, accounting/comparison, statements, backup/status. '
    + `Allowed routes: ${ALLOW.join(', ')}.`,
  inputSchema: {
    type: 'object',
    properties: {
      route: { type: 'string', description: 'Route under /api, e.g. "tax/vat".' },
      query: { type: 'object', description: 'Query parameters, e.g. {"year": 2026}.' },
    },
    required: ['route'],
    additionalProperties: false,
  },
}];

async function callTool(name: string, args: Record<string, any>): Promise<{ text: string; isError: boolean }> {
  if (name !== 'crm_get') return { text: `unknown tool ${name}`, isError: true };
  const route = String(args.route || '');
  if (!allowed(route)) return { text: `Route non autorisée (lecture seule, liste fermée) : ${route}`, isError: true };
  try {
    const r = await get(route, args.query && typeof args.query === 'object' ? args.query : {});
    const body = r.body.length > MAX_CHARS ? r.body.slice(0, MAX_CHARS) + `\n… (tronqué, ${r.body.length} caractères ; affine la requête)` : r.body;
    return { text: `HTTP ${r.status}\n${body}`, isError: r.status >= 400 };
  } catch (e) {
    return { text: `MyLittleCRM injoignable (${String((e as Error).message || e)}). Est-il lancé ?`, isError: true };
  }
}

function send(m: unknown): void { process.stdout.write(JSON.stringify(m) + '\n'); }

if (require.main === module) {
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
      if (m.id === undefined) continue;
      if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mylittlecrm', version: '1.0.0' } } });
      else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
      else if (m.method === 'tools/call') {
        void callTool(String(m.params?.name), m.params?.arguments || {})
          .then((r) => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r.text }], isError: r.isError } }));
      } else if (m.method === 'ping') send({ jsonrpc: '2.0', id: m.id, result: {} });
      else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
    }
  });
}
