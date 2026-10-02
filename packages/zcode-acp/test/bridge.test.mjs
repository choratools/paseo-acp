import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';

const bridge = fileURLToPath(new URL('../bridge.mjs', import.meta.url));
const runtime = fileURLToPath(new URL('./fake-runtime.mjs', import.meta.url));
async function waitFor(predicate, timeout = 2500) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error('Timed out waiting for bridge evidence');
}
async function start(t, { directory, create = true, runtimeEnv = {} } = {}) {
  const dir = directory ?? await mkdtemp(join(tmpdir(), 'zcode-acp-test-'));
  await chmod(runtime, 0o755);
  const runId = randomUUID();
  const logPath = join(dir, `${runId}-native.ndjson`);
  const pidPath = join(dir, `${runId}-native.pid`);
  const grandchildPidPath = join(dir, `${runId}-grandchild.pid`);
  const builtinPath = join(dir, 'builtin.json');
  const personalPath = join(dir, 'personal.json');
  await writeFile(builtinPath, JSON.stringify({ schemaVersion: 1, revision: 30, config: { providerConfigRules: { templateRules: [], providerRules: [] } } }));
  await writeFile(personalPath, '{}');
  const child = spawn(process.execPath, [bridge], {
    env: { ...process.env, ZCODE_ACP_RUNTIME: runtime, ZCODE_ACP_RPC_TIMEOUT_MS: '1000', ZCODE_ACP_CANCEL_TIMEOUT_MS: '1000', ZCODE_TEST_LOG: logPath, ZCODE_TEST_PID: pidPath,
      ZCODE_DATA_BASE_DIR: dir, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath, ZCODE_TEST_GRANDCHILD_PID: grandchildPidPath, ...runtimeEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  const pending = new Map();
  let serial = 0;
  let buffer = '';
  let stderr = '';
  let permission;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', () => {});
  child.stdout.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      messages.push(value);
      if (value.method === 'session/request_permission') {
        permission = value;
        send({ jsonrpc: '2.0', id: value.id, result: { outcome: { outcome: 'selected', optionId: value.params.options[0].optionId } } });
      } else if (value.id !== undefined && pending.has(value.id)) {
        const entry = pending.get(value.id); pending.delete(value.id); clearTimeout(entry.timer); entry.resolve(value);
      }
    }
  });
  function send(value) { child.stdin.write(`${JSON.stringify(value)}\n`); }
  function request(method, params = {}) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No response to ${method}; stderr: ${stderr}`)); }, 3000);
      pending.set(id, { resolve, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }
  const nativeLog = async () => {
    try { return (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    child.stdin.end();
    try {
      const result = await Promise.race([exited, delay(2500).then(() => { throw new Error(`Bridge failed to exit after EOF; stderr: ${stderr}`); })]);
      const pid = Number(await readFile(pidPath, 'utf8').catch(() => '0'));
      if (pid) await waitFor(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } });
      return result;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      const pid = Number(await readFile(pidPath, 'utf8').catch(() => '0'));
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      if (!directory) await rm(dir, { recursive: true, force: true });
    }
  }
  t.after(stop);
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(initialized.error, undefined, JSON.stringify(initialized));
  assert.equal(initialized.result.protocolVersion, 1);
  assert.deepEqual(initialized.result.agentCapabilities.mcpCapabilities, { http: true, sse: true });
  let created;
  if (create) {
    created = await request('session/new', { cwd: dir, mcpServers: [] });
    assert.equal(created.error, undefined, JSON.stringify(created));
    assert.equal(typeof created.result.sessionId, 'string');
    assert.equal(created.result.modes.currentModeId, 'build');
  }
  return { request, send, messages, nativeLog, sessionId: created?.result.sessionId, configOptions: created?.result.configOptions, cwd: dir, grandchildPidPath, stop, get permission() { return permission; } };
}
const prompt = (h, text) => h.request('session/prompt', { sessionId: h.sessionId, prompt: [{ type: 'text', text }] });
const chunks = h => h.messages.filter(value => value.method === 'session/update' && value.params.update.sessionUpdate === 'agent_message_chunk').map(value => value.params.update.content.text).join('');

test('native session persists across turns and completion does not duplicate streamed text', async t => {
  const h = await start(t);
  for (const text of ['first', 'second']) {
    const reply = await prompt(h, text);
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    assert.equal(reply.result.stopReason, 'end_turn');
  }
  assert.equal(chunks(h), 'answer:firstanswer:second');
  const log = await h.nativeLog();
  assert.deepEqual(log.find(value => value.kind === 'start').args, ['app-server', '--surface', 'terminal', '--no-color']);
  assert.equal(log.filter(value => value.method === 'session/create').length, 1);
  assert.equal(log.filter(value => value.method === 'provider/updateAccountConfig').length, 1);
  assert.deepEqual(log.find(value => value.method === 'provider/updateAccountConfig').params.providers, {});
  const sends = log.filter(value => value.method === 'session/send');
  assert.equal(sends.length, 2);
  assert.equal(sends[0].params.sessionId, sends[1].params.sessionId);
  assert.ok(log.some(value => value.id === 'prefs-request' && value.error?.code === -32601));
});

test('model, mode, config, load, list, and close use the native runtime', async t => {
  const h = await start(t);
  const calls = [
    ['session/set_model', { modelId: 'GLM-5.3-Flash' }],
    ['session/set_mode', { modeId: 'build' }],
    ['session/set_config_option', { configId: 'model', value: 'GLM-5.3' }],
    ['session/set_config_option', { configId: 'mode', value: 'yolo' }],
    ['session/close', {}],
    ['session/load', { cwd: h.cwd, mcpServers: [] }],
    ['session/list', { cwd: h.cwd }],
    ['session/close', {}],
  ];
  for (const [method, params] of calls) {
    const reply = await h.request(method, { sessionId: h.sessionId, ...params });
    assert.equal(reply.error, undefined, `${method}: ${JSON.stringify(reply)}`);
  }
  const log = await h.nativeLog();
  assert.ok(log.some(value => value.method === 'session/resume'));
  assert.ok(log.some(value => value.method === 'session/list'));
  assert.ok(log.some(value => value.method === 'session/close'));
  const model = log.find(value => value.method === 'session/setModel');
  assert.deepEqual(model.params.model, { providerId: 'account:test', modelId: 'GLM-5.3-Flash' });
  assert.equal(model.params.persistAsWorkspaceLastUsed, false);
  assert.equal(log.find(value => value.method === 'session/setMode').params.mode, 'build');
});

test('invalid session, invalid model, and unknown ACP methods return errors', async t => {
  const h = await start(t);
  const invalidSession = await h.request('session/prompt', { sessionId: 'missing', prompt: [{ type: 'text', text: 'hello' }] });
  assert.ok(invalidSession.error);
  const invalidModel = await h.request('session/set_model', { sessionId: h.sessionId, modelId: 'no-such-model' });
  assert.ok(invalidModel.error);
  assert.equal((await h.request('unknown/method')).error.code, -32601);
});

test('native reasoning levels are exposed and selected through ACP config', async t => {
  const h = await start(t);
  const initial = h.configOptions.find(option => option.id === 'thought_level');
  assert.equal(initial.currentValue, 'low');
  assert.deepEqual(initial.options.map(option => option.value), ['low', 'high', 'max']);
  const selected = await h.request('session/set_config_option', { sessionId: h.sessionId, configId: 'thought_level', value: 'max' });
  assert.equal(selected.error, undefined, JSON.stringify(selected));
  assert.equal(selected.result.configOptions.find(option => option.id === 'thought_level').currentValue, 'max');
  const invalid = await h.request('session/set_config_option', { sessionId: h.sessionId, configId: 'thought_level', value: 'ultra' });
  assert.ok(invalid.error);
  const setters = (await h.nativeLog()).filter(value => value.method === 'session/setThoughtLevel');
  assert.equal(setters.length, 1);
  assert.equal(setters[0].params.thoughtLevel, 'max');
});

test('MCP descriptors pass through session creation and reload and malformed descriptors are rejected', async t => {
  const h = await start(t);
  const mcpServers = [
    { name: 'local-fixture', command: '/fixture/mcp', args: ['--stdio'], env: [{ name: 'MCP_FIXTURE', value: 'yes' }] },
    { name: 'http-fixture', type: 'http', url: 'https://example.test/mcp', headers: [{ name: 'X-Fixture', value: 'http' }] },
    { name: 'sse-fixture', type: 'sse', url: 'http://127.0.0.1:43210/events', headers: [{ name: 'X-Fixture', value: 'sse' }] },
  ];
  const created = await h.request('session/new', { cwd: h.cwd, mcpServers });
  assert.equal(created.error, undefined, JSON.stringify(created));
  const sessionId = created.result.sessionId;
  assert.equal((await h.request('session/close', { sessionId })).error, undefined);
  assert.equal((await h.request('session/load', { sessionId, cwd: h.cwd, mcpServers })).error, undefined);
  const log = await h.nativeLog();
  assert.deepEqual(log.filter(value => value.method === 'session/create').at(-1).params.mcpServers, mcpServers);
  assert.deepEqual(log.find(value => value.method === 'session/resume').params.mcpServers, mcpServers);
  const createCount = log.filter(value => value.method === 'session/create').length;
  for (const invalid of [
    { name: '', command: '/fixture/mcp', args: [] },
    { name: 'bad-args', command: '/fixture/mcp', args: [1] },
    { name: 'bad-env', command: '/fixture/mcp', args: [], env: [{ name: 'KEY', value: 1 }] },
    { name: 'bad-url', type: 'http', url: 'file:///tmp/mcp' },
    { name: 'bad-headers', type: 'sse', url: 'http://example.test/events', headers: { Authorization: 'invalid' } },
  ]) assert.ok((await h.request('session/new', { cwd: h.cwd, mcpServers: [invalid] })).error);
  assert.equal((await h.nativeLog()).filter(value => value.method === 'session/create').length, createCount);
});

test('blank session survives bridge restart with its ACP ID and settings while native IDs change', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-acp-restart-'));
  let first, second, third;
  try {
    first = await start(t, { directory: dir });
    const originalId = first.sessionId;
    for (const [configId, value] of [['mode', 'yolo'], ['model', 'GLM-5.3-Flash'], ['thought_level', 'max']]) {
      assert.equal((await first.request('session/set_config_option', { sessionId: originalId, configId, value })).error, undefined);
    }
    await first.stop();
    second = await start(t, { directory: dir, create: false });
    const loaded = await second.request('session/load', { sessionId: originalId, cwd: dir, mcpServers: [] });
    assert.equal(loaded.error, undefined, JSON.stringify(loaded));
    assert.equal(loaded.result.modes.currentModeId, 'yolo');
    assert.equal(loaded.result.models.currentModelId, 'account:test/GLM-5.3-Flash');
    assert.equal(loaded.result.configOptions.find(option => option.id === 'thought_level').currentValue, 'max');
    const beforePrompt = await second.nativeLog();
    assert.equal(beforePrompt.find(value => value.method === 'session/resume').params.sessionId, originalId);
    const nativeId = beforePrompt.find(value => value.method === 'session/subscribe').params.sessionId;
    assert.notEqual(nativeId, originalId);
    const list = await second.request('session/list', { cwd: dir });
    assert.deepEqual(list.result.sessions.map(session => session.sessionId), [originalId]);
    second.sessionId = originalId;
    assert.equal((await prompt(second, 'restored')).result?.stopReason, 'end_turn');
    assert.equal(chunks(second), 'answer:restored');
    assert.ok(second.messages.filter(value => value.method === 'session/update').every(value => value.params.sessionId === originalId));
    assert.equal((await second.nativeLog()).find(value => value.method === 'session/send').params.sessionId, nativeId);
    assert.equal((await prompt(second, 'permission')).result?.stopReason, 'end_turn');
    assert.equal(second.permission.params.sessionId, originalId);
    const slow = prompt(second, 'slow');
    await waitFor(async () => (await second.nativeLog()).some(value => value.method === 'session/send' && value.params.content === 'slow'));
    second.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: originalId } });
    assert.equal((await slow).result?.stopReason, 'cancelled');
    assert.equal((await second.nativeLog()).find(value => value.method === 'session/stop').params.sessionId, nativeId);
    await second.stop();
    third = await start(t, { directory: dir, create: false });
    const missing = await third.request('session/load', { sessionId: originalId, cwd: dir, mcpServers: [] });
    assert.ok(missing.error);
    assert.equal((await third.nativeLog()).find(value => value.method === 'session/resume').params.sessionId, nativeId);
    assert.equal((await third.nativeLog()).filter(value => value.method === 'session/create').length, 0);
  } finally {
    await first?.stop(); await second?.stop(); await third?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a prompted session with missing native history returns an error after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-acp-history-'));
  let first, second;
  try {
    first = await start(t, { directory: dir });
    await prompt(first, 'history-must-be-preserved');
    await first.stop();
    second = await start(t, { directory: dir, create: false });
    const loaded = await second.request('session/load', { sessionId: first.sessionId, cwd: dir, mcpServers: [] });
    assert.ok(loaded.error, JSON.stringify(loaded));
    assert.match(loaded.error.message, /^Session not found:/);
    assert.equal((await second.nativeLog()).filter(value => value.method === 'session/create').length, 0);
  } finally {
    await first?.stop(); await second?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('successful placeholder resume restores saved empty-session mode, model, and reasoning', async t => {
  const h = await start(t, { runtimeEnv: { ZCODE_TEST_PLACEHOLDER_RESUME: '1' } });
  for (const [configId, value] of [['mode', 'plan'], ['model', 'GLM-5.3-Flash'], ['thought_level', 'max']]) {
    assert.equal((await h.request('session/set_config_option', { sessionId: h.sessionId, configId, value })).error, undefined);
  }
  assert.equal((await h.request('session/close', { sessionId: h.sessionId })).error, undefined);
  const loaded = await h.request('session/load', { sessionId: h.sessionId, cwd: h.cwd, mcpServers: [] });
  assert.equal(loaded.error, undefined, JSON.stringify(loaded));
  assert.equal(loaded.result.modes.currentModeId, 'plan');
  assert.equal(loaded.result.models.currentModelId, 'account:test/GLM-5.3-Flash');
  assert.equal(loaded.result.configOptions.find(option => option.id === 'thought_level').currentValue, 'max');
  const log = await h.nativeLog();
  assert.equal(log.filter(value => value.method === 'session/create').length, 1, 'successful resume must not recreate');
  assert.equal(log.filter(value => value.method === 'session/resume').length, 1);
  assert.equal(log.filter(value => value.method === 'session/setMode').at(-1).params.mode, 'plan');
});

test('streamed tool JSON remains parsed through omitted-input scheduling and completed output', async t => {
  const h = await start(t);
  assert.equal((await prompt(h, 'tool')).result?.stopReason, 'end_turn');
  const updates = h.messages.filter(value => value.method === 'session/update' && value.params.update.toolCallId === 'streamed-tool').map(value => value.params.update);
  assert.equal(updates[0].sessionUpdate, 'tool_call');
  assert.equal(updates[0].status, 'pending');
  assert.equal(updates[0].kind, 'read');
  assert.equal(updates[1].rawInput, '{"path":"/tmp/');
  assert.deepEqual(updates[2].rawInput, { path: '/tmp/fixture', limit: 2 });
  const scheduled = updates.filter(update => update.status === 'pending').at(-1);
  assert.equal(Object.hasOwn(scheduled, 'rawInput'), false, 'omitted input must leave previously parsed input intact');
  assert.ok(updates.some(update => update.status === 'in_progress'));
  const final = Object.assign({}, ...updates);
  assert.deepEqual(final.rawInput, { path: '/tmp/fixture', limit: 2 });
  assert.equal(final.status, 'completed');
  assert.deepEqual(final.rawOutput, { success: true, output: 'tool-output' });
  assert.deepEqual(final.content, [{ type: 'content', content: { type: 'text', text: 'tool-output' } }]);
});

test('plan flag survives base-mode snapshots and automatic plan exit updates ACP and persisted mode', async t => {
  const h = await start(t);
  for (const [configId, value] of [['mode', 'plan'], ['model', 'GLM-5.3-Flash'], ['thought_level', 'high']]) {
    const reply = await h.request('session/set_config_option', { sessionId: h.sessionId, configId, value });
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    assert.equal(reply.result.configOptions.find(option => option.id === 'mode').currentValue, 'plan');
  }
  assert.equal((await prompt(h, 'plan-exit')).result?.stopReason, 'end_turn');
  const modes = h.messages.filter(value => value.method === 'session/update' && value.params.update.sessionUpdate === 'current_mode_update');
  assert.equal(modes.at(-1).params.update.currentModeId, 'build');
  const configs = h.messages.filter(value => value.method === 'session/update' && value.params.update.sessionUpdate === 'config_option_update');
  assert.equal(configs.at(-1).params.update.configOptions.find(option => option.id === 'mode').currentValue, 'build');
  const metadata = join(h.cwd, '.zcode/v2/paseo-acp/sessions', `${createHash('sha256').update(h.sessionId).digest('hex')}.json`);
  await waitFor(async () => JSON.parse(await readFile(metadata, 'utf8')).mode === 'build');
  assert.equal((await h.request('session/close', { sessionId: h.sessionId })).error, undefined);
  const loaded = await h.request('session/load', { sessionId: h.sessionId, cwd: h.cwd, mcpServers: [] });
  assert.equal(loaded.error, undefined, JSON.stringify(loaded));
  assert.equal(loaded.result.modes.currentModeId, 'build');
});

test('immediate cancellation ends the prompt and permits the next turn', async t => {
  const h = await start(t);
  const pending = prompt(h, 'slow');
  h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: h.sessionId } });
  const cancelled = await pending;
  assert.equal(cancelled.result?.stopReason, 'cancelled', JSON.stringify(cancelled));
  assert.equal((await prompt(h, 'after-immediate-cancel')).result?.stopReason, 'end_turn');
  const sends = (await h.nativeLog()).filter(value => value.method === 'session/send');
  assert.deepEqual(sends.map(value => value.params.content), ['after-immediate-cancel']);
});

test('overlapping prompts are rejected and cancel notification has no response', async t => {
  const h = await start(t);
  const first = prompt(h, 'slow');
  await waitFor(async () => (await h.nativeLog()).some(value => value.method === 'session/send'));
  const overlap = await prompt(h, 'overlap');
  assert.ok(overlap.error);
  h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: h.sessionId } });
  const reply = await first;
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.equal(reply.result.stopReason, 'cancelled');
  await delay(40);
  assert.equal(h.messages.filter(value => 'result' in value || 'error' in value).some(value => value.id === null || value.id === undefined), false);
  assert.equal((await h.nativeLog()).filter(value => value.method === 'session/send').length, 1);
});

test('native turn errors and runtime crashes are not reported as cancellation', async t => {
  const h = await start(t);
  for (const text of ['error', 'crash']) {
    const reply = await prompt(h, text);
    assert.ok(reply.error, `${text}: ${JSON.stringify(reply)}`);
    assert.notEqual(reply.result?.stopReason, 'cancelled');
  }
});

test('acknowledged prompt initialization failure returns an error and allows another turn', async t => {
  const h = await start(t);
  const failed = await prompt(h, 'early-failure');
  assert.ok(failed.error, JSON.stringify(failed));
  assert.match(failed.error.message, /Early prompt failure/);
  assert.notEqual(failed.result?.stopReason, 'cancelled');
  const recovered = await prompt(h, 'recovered');
  assert.equal(recovered.result?.stopReason, 'end_turn', JSON.stringify(recovered));
  assert.equal(chunks(h), 'answer:recovered');
});

test('permission selection forwards the original native option response verbatim', async t => {
  const h = await start(t);
  const reply = await prompt(h, 'permission');
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.ok(h.permission);
  assert.equal(h.permission.params.options[0].optionId, 'allow');
  const nativeReply = (await h.nativeLog()).find(value => typeof value.id === 'string' && value.id.startsWith('permission-') && value.result);
  assert.deepEqual(nativeReply.result, { decision: 'allow' });
});

test('native deny permission is mapped to ACP reject_once and forwards the deny response', async t => {
  const h = await start(t);
  const reply = await prompt(h, 'permission-deny');
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.equal(h.permission.params.options[0].optionId, 'deny');
  assert.equal(h.permission.params.options[0].kind, 'reject_once');
  const nativeReply = (await h.nativeLog()).find(value => typeof value.id === 'string' && value.id.startsWith('permission-') && value.result);
  assert.deepEqual(nativeReply.result, { decision: 'deny' });
});

test('session permission and native allow aliases retain their scope label and response', async t => {
  const h = await start(t);
  for (const [text, kind] of [['permission-session', 'allow_always'], ['permission-once', 'allow_once'], ['permission-always', 'allow_always']]) {
    const reply = await prompt(h, text);
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    assert.equal(h.permission.params.options[0].kind, kind);
    const responses = (await h.nativeLog()).filter(value => typeof value.id === 'string' && value.id.startsWith('permission-') && value.result);
    assert.deepEqual(responses.at(-1).result, text === 'permission-session' ? { decision: 'allow', scope: 'session' } : { decision: 'allow' });
    if (text === 'permission-session') assert.equal(h.permission.params.options[0].name, 'Allow for this session');
  }
});

test('ACP stdin EOF stops the bridge and leaves no native runtime process', async t => {
  const h = await start(t);
  await prompt(h, 'before-eof');
  const result = await h.stop();
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
});

test('EOF kills a runtime grandchild that ignores SIGTERM', { skip: process.platform !== 'linux' }, async t => {
  const h = await start(t);
  await prompt(h, 'spawn-grandchild');
  const pid = await waitFor(async () => Number(await readFile(h.grandchildPidPath, 'utf8').catch(() => '0')));
  const running = async () => {
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      return !/^State:\s+Z/m.test(status);
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  process.kill(pid, 'SIGTERM');
  await delay(30);
  assert.equal(await running(), true, 'fixture must demonstrably ignore SIGTERM');
  await h.stop();
  await waitFor(async () => !(await running()));
});
