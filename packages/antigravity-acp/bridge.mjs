#!/usr/bin/env node

/**
 * Google Antigravity ACP bridge for Paseo.
 *
 * Transport: line-delimited JSON-RPC 2.0 over stdio.
 * Runtime: local `agy` CLI in stream-json print mode.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const DEBUG = process.env.AGY_ACP_DEBUG === '1';
const allowUnsafe = process.env.AGY_ACP_ALLOW_UNSAFE === '1';
const rpcTimeoutMs = positiveInt(process.env.AGY_ACP_RPC_TIMEOUT_MS, 10 * 60 * 1000);
const modelProbeTimeoutMs = positiveInt(process.env.AGY_ACP_MODEL_PROBE_TIMEOUT_MS, 5000);
const killGraceMs = positiveInt(process.env.AGY_ACP_KILL_GRACE_MS, 1500);

const INHERIT_MODEL = { modelId: 'inherit', name: 'Default (Antigravity CLI)', description: 'Use the model configured in the installed agy CLI.' };
const MODES = [
  { id: 'plan', name: 'Plan', description: 'Ask Antigravity to plan and analyze before making changes.' },
  { id: 'standard', name: 'Standard', description: 'Use Antigravity default execution mode. Terminal permission prompts are not available through ACP.' },
  { id: 'accept-edits', name: 'Auto Edit', description: 'Pass --mode accept-edits to Antigravity. Tool and terminal prompts may still require native CLI support.' },
];

function debug(...args) {
  if (DEBUG) process.stderr.write(`[AGY-ACP] ${args.map(String).join(' ')}\n`);
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fault(message, code = -32602) {
  return Object.assign(new Error(message), { code });
}

function textContent(text) {
  return { type: 'text', text };
}

function commandConfig() {
  const command = (process.env.AGY_ACP_COMMAND || 'agy').trim();
  return { command: command || 'agy', args: [] };
}
function modelNameFromId(id) {
  return id.split('-').map(part => part ? part[0].toUpperCase() + part.slice(1) : part).join(' ');
}

async function discoverModels() {
  const base = commandConfig();
  return await new Promise(resolve => {
    let stdout = '';
    let stdoutBytes = 0;
    let settled = false;
    const done = (models, keepHardTimer = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!keepHardTimer) clearTimeout(hardTimer);
      resolve(models);
    };
    const child = spawn(base.command, [...base.args, 'models'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done([INHERIT_MODEL], true);
    }, modelProbeTimeoutMs);
    const hardTimer = setTimeout(() => child.kill('SIGKILL'), modelProbeTimeoutMs + 500);
    hardTimer.unref?.();
    child.once('close', () => clearTimeout(hardTimer));
    child.stdout.on('data', data => {
      stdoutBytes += data.length;
      if (stdoutBytes > 1024 * 1024) {
        child.kill('SIGTERM');
        done([INHERIT_MODEL], true);
        return;
      }
      stdout += data.toString('utf8');
    });
    child.stderr.resume();
    child.on('error', () => { done([INHERIT_MODEL]); });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) { done([INHERIT_MODEL]); return; }
      const models = [];
      const seen = new Set(['inherit']);
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || /^fetching\b/i.test(trimmed)) continue;
        const [id, ...nameParts] = trimmed.split(/\t+/);
        if (!id || /\s/.test(id) || seen.has(id)) continue;
        seen.add(id);
        models.push({ modelId: id, name: nameParts.join(' ').trim() || modelNameFromId(id) });
      }
      done(models.length ? [INHERIT_MODEL, ...models] : [INHERIT_MODEL]);
    });
  });
}

let modelCatalogPromise;
function modelCatalog() {
  modelCatalogPromise ??= discoverModels().catch(error => {
    debug('model discovery failed:', error?.message || error);
    return [INHERIT_MODEL];
  });
  return modelCatalogPromise;
}

function promptText(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (!Array.isArray(prompt)) throw fault('prompt must be a string or ACP content block array');
  return prompt.map(block => {
    if (typeof block === 'string') return block;
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    if (block?.type === 'resource' && typeof block.resource?.text === 'string') return `${block.resource.uri || 'Resource'}\n${block.resource.text}`;
    if (block?.type === 'resource_link' && typeof block.uri === 'string') return `${block.name || 'Resource'}: ${block.uri}`;
    throw fault(`Unsupported prompt content: ${block?.type || 'unknown'}`);
  }).join('\n');
}

function toolKind(name) {
  if (/edit|write|patch/i.test(name)) return 'edit';
  if (/read|view/i.test(name)) return 'read';
  if (/search|grep|glob/i.test(name)) return 'search';
  if (/bash|shell|command|terminal/i.test(name)) return 'execute';
  if (/web|fetch|browse/i.test(name)) return 'fetch';
  return 'other';
}

class AntigravitySession {
  constructor(id, cwd) {
    this.id = id;
    this.cwd = cwd;
    this.model = 'inherit';
    this.mode = 'plan';
    this.child = null;
    this.generation = 0;
    this.turn = null;
    this.closing = false;
    this.lastText = '';
    this.tools = new Map();
  }

  state(models) {
    return {
      models: { currentModelId: this.model, availableModels: models },
      modes: { currentModeId: this.mode, availableModes: MODES },
      configOptions: [
        { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: this.mode, options: MODES.map(mode => ({ value: mode.id, name: mode.name, description: mode.description })) },
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: this.model, options: models.map(model => ({ value: model.modelId, name: model.name, ...(model.description ? { description: model.description } : {}) })) },
      ],
    };
  }

  args() {
    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands'];
    if (allowUnsafe) args.push('--dangerously-skip-permissions');
    if (this.mode === 'plan' || this.mode === 'accept-edits') args.push('--mode', this.mode);
    if (this.model !== 'inherit') args.push('--model', this.model);
    return args;
  }

  ensureChild() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return;
    const base = commandConfig();
    const child = spawn(base.command, [...base.args, ...this.args()], {
      cwd: this.cwd,
      detached: process.platform !== 'win32',
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const generation = ++this.generation;
    this.child = child;
    child.stderr.resume();
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => { if (this.child === child && generation === this.generation) this.handleLine(line); });
    child.stdin.on('error', error => { if (this.child === child && generation === this.generation) this.failTurn(error); });
    child.on('error', error => { if (this.child === child && generation === this.generation) this.failTurn(error); });
    child.on('close', (code, signal) => {
      lines.close();
      if (this.child === child) this.child = null;
      if (generation !== this.generation) return;
      const turn = this.turn;
      if (!turn) return;
      if (turn.cancelRequested || this.closing) this.finish({ stopReason: 'cancelled' });
      else this.failTurn(fault(`Antigravity CLI exited before completing the turn (${signal || code})`, -32603));
    });
  }

  writePrompt(content) {
    if (!this.child?.stdin.writable) throw fault('Antigravity CLI is unavailable', -32603);
    this.child.stdin.write(`${JSON.stringify({ event: 'user', message: { content } })}\n`);
  }

  handleLine(line) {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { return; }
    if (!this.turn) return;

    if (event.event === 'step_update' && event.step_update) {
      this.handleStep(event.step_update);
      return;
    }
    if (event.event === 'result') {
      const result = event.result || {};
      const text = typeof result.text === 'string' ? result.text : typeof result.response === 'string' ? result.response : '';
      if (text && !this.lastText) this.agentText(text);
      if (result.status === 'SUCCESS' || result.status === undefined) {
        this.finish({ stopReason: 'end_turn', ...(result.usage ? { usage: { inputTokens: result.usage.input_tokens || 0, outputTokens: result.usage.output_tokens || 0 } } : {}) });
      } else if (/cancel/i.test(String(result.status))) {
        this.finish({ stopReason: 'cancelled' });
      } else {
        this.failTurn(fault(`Antigravity turn failed: ${result.error || result.status || 'unknown error'}`, -32603));
      }
    }
  }

  handleStep(update) {
    if (update.step_type === 'agent_response' && typeof update.text_delta === 'string') {
      this.agentText(update.text_delta);
      return;
    }
    if (update.step_type !== 'tool') return;
    const id = `tool_${update.step_index ?? randomUUID()}`;
    const title = update.tool_name || this.tools.get(id)?.title || 'Antigravity tool';
    if (update.state === 'ACTIVE') {
      this.tools.set(id, { title });
      notify('session/update', { sessionId: this.id, update: { sessionUpdate: 'tool_call', toolCallId: id, title, kind: toolKind(title), status: 'pending', rawInput: update.tool_info?.parameters || {} } });
    } else if (update.state === 'DONE' || update.state === 'ERROR') {
      notify('session/update', { sessionId: this.id, update: { sessionUpdate: 'tool_call_update', toolCallId: id, title, kind: toolKind(title), status: update.state === 'DONE' ? 'completed' : 'failed', rawOutput: update.tool_info || {} } });
    }
  }

  agentText(text) {
    this.lastText += text;
    notify('session/update', { sessionId: this.id, update: { sessionUpdate: 'agent_message_chunk', content: textContent(text) } });
  }

  async prompt(content) {
    if (this.closing) throw fault('Session is closing', -32000);
    if (this.turn) throw fault('Session is busy', -32000);
    this.lastText = '';
    this.tools.clear();
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => this.failTurn(fault('Antigravity prompt timed out', -32603)), rpcTimeoutMs);
    timer.unref?.();
    this.turn = { resolve, reject, cancelRequested: false, timer };
    try {
      this.ensureChild();
      this.writePrompt(content);
    } catch (error) {
      this.failTurn(error);
    }
    return await done;
  }

  finish(result) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    clearTimeout(turn.timer);
    turn.resolve(result);
  }

  failTurn(error) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    clearTimeout(turn.timer);
    turn.reject(error);
  }

  cancel() {
    if (this.turn) this.turn.cancelRequested = true;
    const child = this.child;
    if (child) {
      this.child = null;
      this.generation += 1;
      this.killChild(child, 'SIGTERM');
      const hard = setTimeout(() => this.killChild(child, 'SIGKILL'), killGraceMs);
      hard.unref?.();
      child.once('close', () => clearTimeout(hard));
    }
    if (this.turn) this.finish({ stopReason: 'cancelled' });
  }

  kill(signal) {
    const child = this.child;
    if (child) this.killChild(child, signal);
  }

  killChild(child, signal) {
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') debug('process cleanup failed:', error.code || error.message);
    }
  }

  async close() {
    this.closing = true;
    const child = this.child;
    this.cancel();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const soft = setTimeout(() => this.killChild(child, 'SIGTERM'), 10);
      const hard = setTimeout(() => { this.killChild(child, 'SIGKILL'); resolve(); }, killGraceMs);
      child.once('close', () => { clearTimeout(soft); clearTimeout(hard); resolve(); });
      try { child.stdin.end(); } catch {}
    });
  }
}

const sessions = new Map();
let closed = false;

function write(message) {
  if (!closed) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function respond(id, result, error) {
  write({ id, ...(error ? { error: { code: error.code ?? -32603, message: error.message || 'Internal error' } } : { result: result ?? {} }) });
}

function notify(method, params) {
  write({ method, params });
}

async function workspace(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fault('cwd must be an absolute directory path');
  if (!(await stat(cwd)).isDirectory()) throw fault('cwd must be a directory');
  return cwd;
}

function getSession(params, idle = false) {
  const session = sessions.get(params?.sessionId);
  if (!session) throw fault(`Session not found: ${params?.sessionId}`);
  if (session.closing) throw fault('Session is closing', -32000);
  if (idle && session.turn) throw fault('Session is busy', -32000);
  return session;
}

async function handle(method, params = {}) {
  switch (method) {
    case 'initialize':
      if (params.protocolVersion !== 1) throw fault('ACP protocol version 1 is required');
      return {
        protocolVersion: 1,
        agentInfo: { name: 'Google Antigravity ACP Bridge', version: '1.0.0' },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { embeddedContext: true },
          sessionCapabilities: { close: {} },
        },
        authMethods: [],
      };
    case 'session/new': {
      const cwd = await workspace(params.cwd || process.cwd());
      const session = new AntigravitySession(randomUUID(), cwd);
      sessions.set(session.id, session);
      return { sessionId: session.id, ...session.state(await modelCatalog()) };
    }
    case 'session/set_mode': {
      const session = getSession(params, true);
      if (!MODES.some(mode => mode.id === params.modeId)) throw fault(`Unknown mode: ${params.modeId}`);
      session.mode = params.modeId;
      await session.close();
      session.closing = false;
      return {};
    }
    case 'session/set_model': {
      const session = getSession(params, true);
      const models = await modelCatalog();
      if (!models.some(model => model.modelId === params.modelId)) throw fault(`Unknown model: ${params.modelId}`);
      session.model = params.modelId;
      await session.close();
      session.closing = false;
      return {};
    }
    case 'session/prompt': {
      const session = getSession(params, true);
      const content = promptText(params.prompt);
      if (!content.trim()) throw fault('Prompt is empty');
      return await session.prompt(content);
    }
    case 'session/cancel':
      getSession(params).cancel();
      return {};
    case 'session/close': {
      const session = getSession(params);
      await session.close();
      sessions.delete(session.id);
      return {};
    }
    case 'authenticate':
      throw fault('Authenticate with the installed agy CLI before using this bridge', -32601);
    case 'session/load':
    case 'session/resume':
    case 'session/list':
      throw fault(`${method} is not supported by this Antigravity ACP bridge`, -32601);
    default:
      throw fault(`Method not found: ${method}`, -32601);
  }
}

async function receive(message) {
  if (!isObject(message) || message.jsonrpc !== '2.0') {
    respond(null, undefined, fault('Invalid JSON-RPC request', -32600));
    return;
  }
  if (hasOwn(message, 'method') && typeof message.method !== 'string') {
    if (hasOwn(message, 'id')) respond(message.id, undefined, fault('Invalid JSON-RPC request', -32600));
    return;
  }
  if (!hasOwn(message, 'method')) return;
  const hasId = hasOwn(message, 'id');
  if (hasId && typeof message.id !== 'string' && typeof message.id !== 'number' && message.id !== null) {
    respond(null, undefined, fault('Invalid JSON-RPC request', -32600));
    return;
  }
  if (message.params !== undefined && !isObject(message.params)) {
    if (hasId) respond(message.id, undefined, fault('Invalid JSON-RPC request', -32600));
    return;
  }
  try {
    const result = await handle(message.method, message.params || {});
    if (hasId) respond(message.id, result);
  } catch (error) {
    if (hasId) respond(message.id, undefined, error);
  }
}

async function stop() {
  if (closed) return;
  closed = true;
  const openSessions = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(openSessions.map(session => session.close()));
}

export function main() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (!line.trim() || closed) return;
    let message;
    try { message = JSON.parse(line); }
    catch { respond(null, undefined, fault('Parse error', -32700)); return; }
    void receive(message);
  });
  input.on('close', () => { void stop(); });
  process.once('SIGTERM', () => { input.close(); void stop().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { input.close(); void stop().finally(() => process.exit(0)); });
  process.stdout.on('error', () => { input.close(); void stop(); });
  return { stop };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
