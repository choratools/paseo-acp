import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const bridge = fileURLToPath(new URL('../bridge.mjs', import.meta.url));

async function start(t, fail = false) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-acp-test-'));
  const runtime = join(dir, 'agy.mjs');
  await writeFile(runtime, `#!/usr/bin/env node
import readline from 'node:readline';
if (process.argv[2] === 'models') process.exit(0);
if (!process.argv.includes('--print=')) {
  console.error('--print consumed the following flag'); process.exit(2);
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const prompt = JSON.parse(line);
  if (${fail}) { console.error('CLI startup diagnostic'); process.exit(2); }
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', text: prompt.message.content } }));
});
`, { mode: 0o755 });
  const child = spawn(process.execPath, [bridge], {
    env: { ...process.env, AGY_ACP_COMMAND: runtime, AGY_ACP_RPC_TIMEOUT_MS: '2000' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let serial = 0;
  lines.on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  t.after(async () => {
    child.stdin.end();
    await exited;
    lines.close();
    await rm(dir, { recursive: true, force: true });
  });
  function request(method, params) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 4000);
      pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  const session = await request('session/new', { cwd: dir });
  assert.equal(session.error, undefined);
  return () => request('session/prompt', { sessionId: session.result.sessionId, prompt: 'hello' });
}

test('stream input uses an explicit empty print argument', { timeout: 8000 }, async t => {
  const prompt = await start(t);
  assert.deepEqual((await prompt()).result, { stopReason: 'end_turn' });
  assert.deepEqual((await prompt()).result, { stopReason: 'end_turn' });
});

test('CLI exit reports stderr diagnostics', { timeout: 8000 }, async t => {
  const prompt = await start(t, true);
  const response = await prompt();
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /\(2\): CLI startup diagnostic/);
});
