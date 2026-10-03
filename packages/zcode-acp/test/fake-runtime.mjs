#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const log = value => appendFileSync(process.env.ZCODE_TEST_LOG, `${JSON.stringify(value)}\n`);
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);
log({ kind: 'start', pid: process.pid, args: process.argv.slice(2) });
writeFileSync(process.env.ZCODE_TEST_PID, String(process.pid));
process.on('exit', () => log({ kind: 'exit' }));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

let counter = 0;
let sequence = 0;
const sessions = new Map();
const turns = new Map();
const permissions = new Map();
const refs = ['GLM-5.3', 'GLM-5.3-Flash'].map(modelId => ({ providerId: 'account:test', modelId }));
function snapshot(sessionId, cwd, mode) {
  const old = sessions.get(sessionId);
  mode ??= old?.session.mode ?? 'build';
  if (mode === 'plan') mode = 'build';
  const result = {
    session: { sessionId, workspace: { workspacePath: cwd ?? old?.session.workspace.workspacePath }, mode, title: 'Fake session', updatedAt: '2026-10-03T00:00:00.000Z' },
    settings: {
      model: { current: refs[0], available: refs.map(ref => ({ ref, label: ref.modelId, properties: {} })) },
      mode: { current: mode },
      thoughtLevel: { current: 'low', available: ['low', 'high', 'max'].map(value => ({ value, label: value })) },
    },
    messages: [],
  };
  sessions.set(sessionId, result);
  return result;
}
function event(sessionId, type, payload) {
  output({ method: 'session/event', params: { sessionId, seq: ++sequence, type, payload } });
}
function finish(turn, resultType = 'success') {
  turns.delete(turn.sessionId);
  if (resultType === 'success') event(turn.sessionId, 'model.streaming', { kind: 'text_delta', delta: turn.answer, assistantMessageId: 'm' });
  event(turn.sessionId, 'turn.completed', {
    inputId: turn.inputId,
    resultType,
    response: resultType === 'success' ? turn.answer : '',
    ...(resultType === 'error' ? { error: { message: 'Native turn failed' } } : {}),
  });
}

output({ id: 'prefs-request', method: 'runtimePrefs/get', params: {} });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  log({ kind: 'message', ...message });
  if (!message.method) {
    const turn = permissions.get(message.id);
    if (turn) { permissions.delete(message.id); finish(turn); }
    return;
  }
  const { id, method, params = {} } = message;
  const reply = result => { if (id !== undefined) output({ id, result }); };
  switch (method) {
    case 'provider/updateAccountConfig': reply({ status: 'received', providerCount: 0 }); break;
    case 'initialize': reply({}); break;
    case 'session/create': {
      const sessionId = `native-${process.pid}-${++counter}`;
      reply(snapshot(sessionId, params.cwd ?? params.workspacePath ?? params.workspace?.workspacePath, params.mode));
      break;
    }
    case 'session/resume':
      if (!sessions.has(params.sessionId)) output({ id, error: { code: -32000, message: `Session not found: ${params.sessionId}` } });
      else reply(process.env.ZCODE_TEST_PLACEHOLDER_RESUME === '1'
        ? snapshot(params.sessionId, sessions.get(params.sessionId).session.workspace.workspacePath, 'build')
        : sessions.get(params.sessionId));
      break;
    case 'session/subscribe': reply({ eventSeq: sequence, events: [] }); break;
    case 'session/read': reply(sessions.get(params.sessionId)); break;
    case 'session/list': reply({ sessions: [...sessions.values()].map(value => value.session), nextCursor: null }); break;
    case 'session/send': {
      const input = params.input ?? params.prompt ?? params.message ?? params;
      const text = typeof input === 'string' ? input : (input.text ?? input.content ?? input.prompt ?? params.text ?? JSON.stringify(input));
      if (turns.has(params.sessionId)) {
        output({ id, error: { code: -32010, message: 'A prompt is already running for this session' } });
        break;
      }
      const turn = { ...params, answer: `answer:${text}` };
      turns.set(params.sessionId, turn);
      reply({ accepted: true, sessionId: params.sessionId });
      if (text === 'slow') break;
      if (text === 'spawn-grandchild') {
        spawn(process.execPath, ['--input-type=module', '-e', "import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); writeFileSync(process.env.ZCODE_TEST_GRANDCHILD_PID, String(process.pid)); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
      }
      if (text === 'tool') {
        setTimeout(() => {
          const tool = { toolCallId: 'streamed-tool', toolName: 'read_file' };
          event(params.sessionId, 'model.streaming', { ...tool, kind: 'tool_input_start' });
          event(params.sessionId, 'model.streaming', { ...tool, kind: 'tool_input_delta', delta: '{"path":"/tmp/' });
          event(params.sessionId, 'model.streaming', { ...tool, kind: 'tool_input_delta', delta: 'fixture","limit":2}' });
          event(params.sessionId, 'model.streaming', { ...tool, kind: 'tool_input_end' });
          event(params.sessionId, 'model.streaming', { ...tool, kind: 'tool_call' });
          event(params.sessionId, 'tool.updated', { ...tool, kind: 'scheduled', inputOmitted: true });
          event(params.sessionId, 'tool.updated', { ...tool, kind: 'started' });
          event(params.sessionId, 'tool.updated', { ...tool, kind: 'result', result: { success: true, output: 'tool-output' } });
          finish(turn);
        }, 15);
        break;
      }
      if (text === 'plan-exit') {
        setTimeout(() => {
          const value = sessions.get(params.sessionId);
          value.settings.mode.current = 'build';
          value.session.mode = 'build';
          event(params.sessionId, 'session.updated', { mode: 'build', planEnabled: false });
          finish(turn);
        }, 15);
        break;
      }
      if (text === 'early-failure') {
        turns.delete(params.sessionId);
        sessions.get(params.sessionId).runtime = { lastError: { message: 'Early prompt failure' } };
        setTimeout(() => output({ method: 'state.updated', params: { scope: 'session', sessionId: params.sessionId, reason: 'prompt_failed', patch: sessions.get(params.sessionId).settings, revision: 1 } }), 15);
        break;
      }
      if (text === 'crash') { setTimeout(() => process.exit(7), 15); break; }
      if (['permission', 'permission-deny', 'permission-session', 'permission-once', 'permission-always'].includes(text)) {
        const permissionId = `permission-${++counter}`;
        permissions.set(permissionId, turn);
        const permissionKinds = { 'permission-session': 'allow_session', 'permission-once': 'allowOnce', 'permission-always': 'allowAlways' };
        const option = text === 'permission-deny'
          ? { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }
          : { optionId: 'allow', kind: permissionKinds[text] ?? 'allow_once', name: text === 'permission-session' ? 'Allow for this session' : 'Allow', response: text === 'permission-session' ? { decision: 'allow', scope: 'session' } : { decision: 'allow' } };
        setTimeout(() => output({ id: permissionId, method: 'interaction/requestPermission', params: {
          sessionId: params.sessionId, toolCallId: 'call-1', toolName: 'read_file', input: { path: '/tmp/example' },
          reason: 'Read example', options: [option],
        } }), 15);
        break;
      }
      setTimeout(() => finish(turn, text === 'error' ? 'error' : 'success'), 15);
      break;
    }
    case 'session/stop': {
      reply({ accepted: true });
      const turn = turns.get(params.sessionId);
      if (turn) setTimeout(() => finish(turn, 'cancelled'), process.env.ZCODE_TEST_STOP_DELAY ? Number(process.env.ZCODE_TEST_STOP_DELAY) : 15);
      break;
    }
    case 'session/close': reply({}); break;
    case 'session/setModel': {
      const value = sessions.get(params.sessionId);
      value.settings.model.current = params.model;
      if (params.model.options?.reasoningLevel) value.settings.thoughtLevel.current = params.model.options.reasoningLevel;
      reply({ ...value, settings: { ...value.settings, model: { ...value.settings.model, available: value.settings.model.available.filter(model => model.ref.modelId === params.model.modelId) } } });
      break;
    }
    case 'session/setMode': {
      const value = sessions.get(params.sessionId);
      const mode = params.mode === 'plan' ? 'build' : params.mode;
      value.settings.mode.current = mode;
      value.session.mode = mode;
      reply({ ...value, settings: { ...value.settings, model: { ...value.settings.model, available: value.settings.model.available.filter(model => model.ref.modelId === value.settings.model.current.modelId) } } });
      event(params.sessionId, 'session.updated', { mode, planEnabled: params.mode === 'plan' });
      break;
    }
    case 'session/setThoughtLevel': {
      const value = sessions.get(params.sessionId);
      value.settings.thoughtLevel.current = params.thoughtLevel;
      value.settings.model.current = { ...value.settings.model.current, options: { ...value.settings.model.current.options, reasoningLevel: params.thoughtLevel } };
      reply(value);
      break;
    }
    default:
      if (/setting|model|mode|config/i.test(method)) reply(sessions.get(params.sessionId) ?? {});
      else if (id !== undefined) output({ id, error: { code: -32601, message: `Unknown native method ${method}` } });
  }
}).on('close', () => process.exit(0));
