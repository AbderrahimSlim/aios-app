/* Keep a local service up alongside the host (e.g. MyLittleCRM's API), without ever starting a duplicate:

     node serviceRun.js <port> <cwd> <entry.js> [args…]

   If something already answers on 127.0.0.1:<port> (an instance the operator started by hand), it exits 0
   and does nothing — the scheduled task does not restart a success. Otherwise it runs `node <entry>` in
   <cwd> and exits with its code, so the task's restart-on-failure brings a crashed service back. */
import { spawn } from 'node:child_process';
import * as net from 'node:net';

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  });
}

async function main(): Promise<void> {
  const [portArg, cwd, entry, ...rest] = process.argv.slice(2);
  const port = Number(portArg);
  if (!port || !cwd || !entry) { console.error('usage: serviceRun <port> <cwd> <entry.js> [args…]'); process.exit(2); }
  if (await portBusy(port)) { console.log(`[service] port ${port} already answers: nothing to start`); process.exit(0); }
  console.log(`[service] starting ${entry} in ${cwd} (port ${port})`);
  const child = spawn(process.execPath, [entry, ...rest], { cwd, stdio: 'inherit', windowsHide: true, env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' } });
  const stop = () => child.kill();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 1));
}

void main();
