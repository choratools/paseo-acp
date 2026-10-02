#!/usr/bin/env node
// ACP <-> ZCode Protocol v1. The installed ZCode bundle owns model execution,
// durable history, permissions and tools; this adapter owns only transport.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerPaths, accountSnapshot, requestAuth } from './account.mjs';
import { SessionMetadata } from './state.mjs';
import { discoverZcode } from '../../lib/runtime.mjs';

const installation = await discoverZcode();
const runtimePath = installation.runtimePath;
const accountEnv = { ...process.env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: installation.builtinPath,
  ...(installation.desktopAsar ? { ZCODE_ACP_DESKTOP_ASAR: installation.desktopAsar } : {}) };
const accountPaths = providerPaths(runtimePath, accountEnv);
const positiveMs = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const rpcTimeout = positiveMs('ZCODE_ACP_RPC_TIMEOUT_MS', 45000);
const cancelTimeout = positiveMs('ZCODE_ACP_CANCEL_TIMEOUT_MS', 10000);
const modes = [
  { id: 'yolo', name: 'Yolo', description: 'ZCode autonomous execution' },
  { id: 'build', name: 'Build', description: 'Standard tools with permission requests' },
  { id: 'edit', name: 'Edit', description: 'Allow edits; request command permissions' },
  { id: 'plan', name: 'Plan', description: 'ZCode planning mode' },
];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fault = (message, code = -32602) => Object.assign(new Error(message), { code });
const textContent = text => ({ type: 'text', text });
const toolContent = text => [{ type: 'content', content: textContent(text) }];
const toolKind = name => {
  if (/edit|write|patch/i.test(name)) return 'edit';
  if (/read|view/i.test(name)) return 'read';
  if (/search|grep|glob/i.test(name)) return 'search';
  if (/bash|shell|command|terminal/i.test(name)) return 'execute';
  if (/web|fetch|browse/i.test(name)) return 'fetch';
  return 'other';
};

class Runtime {
  constructor(onEvent, onRequest, onFailure) {
    this.onEvent = onEvent;
    this.onRequest = onRequest;
    this.onFailure = onFailure;
    this.pending = new Map();
    this.nextId = 0;
    this.child = null;
    this.failed = false;
    this.stopping = false;
  }

  start() {
    if (this.child) return;
    this.child = spawn(process.execPath, [runtimePath, 'app-server', '--surface', 'terminal', '--no-color'], {
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: { ...accountEnv, ...(this.appVersion ? { ZCODE_APP_VERSION: this.appVersion } : {}), NO_COLOR: '1', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: accountPaths.builtin,
        ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: accountPaths.builtin,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: accountPaths.personal },
    });
    // Never forward runtime diagnostic output into ACP messages or debug logs.
    this.child.stderr.resume();
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('close', (code, signal) => {
      clearTimeout(this.killTimer);
      if (!this.stopping) this.fail(fault(`ZCode app-server exited (${signal || code})`, -32603));
      // The owned process group can outlive its leader when a tool ignores EOF.
      this.kill('SIGKILL');
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (!line.trim() || this.failed) return;
      try {
        const msg = JSON.parse(line);
        if (!object(msg)) throw new Error('Invalid ZCode message');
        if (typeof msg.method === 'string') {
          if (own(msg, 'id')) Promise.resolve(this.onRequest(msg, this)).catch(() => {
            this.reply(msg.id, undefined, { code: -32603, message: 'Client interaction failed' });
          });
          else this.onEvent(msg);
        } else if (own(msg, 'id')) {
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) pending.reject(fault(msg.error.message || 'ZCode request failed', msg.error.code ?? -32603));
          else if (own(msg, 'result')) pending.resolve(msg.result);
          else pending.reject(fault('Invalid ZCode response', -32603));
        }
      } catch (error) {
        this.fail(fault(`ZCode protocol error: ${error.message}`, -32603));
      }
    });
  }

  write(msg) {
    if (this.failed || this.stopping || !this.child?.stdin.writable) throw fault('ZCode runtime is unavailable', -32603);
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  reply(id, result, error) {
    if (this.failed || this.stopping) return;
    this.write({ id, ...(error ? { error } : { result }) });
  }

  call(method, params = {}) {
    this.start();
    return new Promise((resolve, reject) => {
      const id = `zcode:${++this.nextId}`;
      const timer = setTimeout(() => this.fail(fault(`ZCode ${method} timed out`, -32603)), rpcTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  kill(signal) {
    if (!this.child?.pid) return;
    try {
      if (process.platform === 'win32') this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') process.stderr.write(`ZCode process cleanup: ${error.code}\n`); }
  }

  fail(error) {
    if (this.failed || this.stopping) return;
    this.failed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.onFailure(error);
    this.kill('SIGTERM');
    this.killTimer = setTimeout(() => this.kill('SIGKILL'), 2000);
    this.killTimer.unref();
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(fault('ACP connection closed', -32603));
    }
    this.pending.clear();
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.kill('SIGTERM'); }, 1500);
      const hardTimer = setTimeout(() => { this.kill('SIGKILL'); }, 3500);
      this.child.once('close', () => { clearTimeout(timer); clearTimeout(hardTimer); resolve(); });
      this.child.stdin.end();
    });
  }
}

export class Bridge {
  constructor(output = process.stdout) {
    this.output = output;
    this.sessions = new Map();
    this.clientRequests = new Map();
    this.nextClientId = 0;
    this.closed = false;
    this.preparation = null;
    this.metadata = new SessionMetadata(path.join(path.dirname(accountPaths.credentials), 'paseo-acp/sessions'));
    this.runtime = new Runtime(msg => this.event(msg), (msg, runtime) => this.reverse(msg, runtime), error => {
      for (const session of this.sessions.values()) {
        session.invalid = true;
        this.finish(session, undefined, error);
      }
      for (const entry of this.clientRequests.values()) entry.resolve({ outcome: { outcome: 'cancelled' } });
      this.clientRequests.clear();
    });
  }

  write(msg) { if (!this.closed) this.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`); }
  update(session, update) { this.write({ method: 'session/update', params: { sessionId: session.id, update } }); }
  reply(id, result, error) {
    this.write({ id, ...(error ? { error: { code: error.code ?? -32603, message: error.message || 'Internal error' } } : { result: result ?? {} }) });
  }

  async receive(msg) {
    if (!object(msg) || msg.jsonrpc !== '2.0') {
      this.reply(null, undefined, fault('Invalid JSON-RPC request', -32600));
      return;
    }
    if (!own(msg, 'method')) {
      const entry = this.clientRequests.get(msg.id);
      if (entry) {
        this.clientRequests.delete(msg.id);
        entry.resolve(msg.error ? { outcome: { outcome: 'cancelled' } } : msg.result);
      }
      return;
    }
    const hasId = own(msg, 'id');
    if (typeof msg.method !== 'string' || (hasId && typeof msg.id !== 'string' && typeof msg.id !== 'number') ||
        (msg.params !== undefined && !object(msg.params))) {
      if (hasId) this.reply(msg.id, undefined, fault('Invalid JSON-RPC request', -32600));
      return;
    }
    try {
      const result = await this.dispatch(msg.method, msg.params || {});
      if (hasId) this.reply(msg.id, result);
    } catch (error) { if (hasId) this.reply(msg.id, undefined, error); }
  }

  session(params, idle = false) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw fault(`Session not found: ${params.sessionId}`);
    if (session.invalid || session.closing) throw fault('Session runtime closed; reload the session', -32000);
    if (idle && (session.turn || session.mutating)) throw fault('Session is busy', -32000);
    return session;
  }

  nativeSession(id) { return [...this.sessions.values()].find(session => session.nativeId === id); }

  async workspace(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fault('cwd must be an absolute directory path');
    if (!(await stat(cwd)).isDirectory()) throw fault('cwd must be a directory');
    return { workspacePath: cwd, workspaceKey: cwd };
  }

  async prepare() {
    if (!this.preparation) this.preparation = (async () => {
      const account = await accountSnapshot(accountPaths, accountEnv);
      this.runtime.appVersion = account.appVersion;
      await this.runtime.call('provider/updateAccountConfig', account.config);
      this.account = account;
      return account;
    })().catch(error => { this.preparation = null; throw error; });
    return this.preparation;
  }

  mcpServers(servers) {
    if (servers === undefined) return [];
    if (!Array.isArray(servers)) throw fault('mcpServers must be an ACP server array');
    const pairs = value => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some(pair => !object(pair) || typeof pair.name !== 'string' || typeof pair.value !== 'string')) {
        throw fault('MCP environment and headers must contain name/value string pairs');
      }
      return value.map(({ name, value }) => ({ name, value }));
    };
    return servers.map(server => {
      if (!object(server) || typeof server.name !== 'string' || !server.name.trim()) throw fault('MCP server name is required');
      if (server.type === 'http' || server.type === 'sse') {
        if (typeof server.url !== 'string') throw fault('MCP server URL is required');
        let url;
        try { url = new URL(server.url); } catch { throw fault('Invalid MCP server URL'); }
        if (!['http:', 'https:'].includes(url.protocol)) throw fault('MCP URL must use HTTP or HTTPS');
        return { name: server.name, type: server.type, url: server.url, headers: pairs(server.headers) };
      }
      if (server.type && server.type !== 'stdio') throw fault(`Unsupported MCP server type: ${server.type}`);
      if (typeof server.command !== 'string' || !server.command || !Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string')) {
        throw fault('MCP stdio server requires a command and string arguments');
      }
      return { name: server.name, command: server.command, args: server.args, env: pairs(server.env) };
    });
  }

  state(session, snapshot) {
    session.snapshot = snapshot;
    const nativeMode = snapshot.settings?.mode?.current || snapshot.session?.mode || 'build';
    session.mode = session.planEnabled ? 'plan' : nativeMode;
    // Mutation/read snapshots deliberately contain only the current model.
    const catalog = (snapshot.settings?.model?.available || []).filter(model => !model.disabledReason);
    if (!session.models || catalog.length > 1) session.models = catalog;
    else for (const model of catalog) {
      if (!session.models.some(existing => JSON.stringify(existing.ref) === JSON.stringify(model.ref))) session.models.push(model);
    }
    session.model = snapshot.settings?.model?.current || snapshot.session?.model;
    const availableModels = session.models.map(model => ({
      modelId: this.modelId(session, model.ref),
      name: `${this.account?.modelBenefits?.[model.ref.providerId]?.[model.ref.modelId]?.join(' + ') || model.providerLabel || this.account?.labels?.[model.ref.providerId] || model.ref.providerId} · ${model.label}`,
      ...((this.account?.modelDescriptions?.[model.ref.providerId]?.[model.ref.modelId] || model.description) ?
        { description: this.account?.modelDescriptions?.[model.ref.providerId]?.[model.ref.modelId] || model.description } : {}),
    }));
    const currentModelId = session.model ? this.modelId(session, session.model) : '';
    const configOptions = [
      { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: session.mode,
        options: modes.map(mode => ({ value: mode.id, name: mode.name, description: mode.description })) },
    ];
    if (availableModels.length && currentModelId) configOptions.push({
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: currentModelId,
      options: availableModels.map(model => ({ value: model.modelId, name: model.name, ...(model.description ? { description: model.description } : {}) })),
    });
    session.thoughtLevels = snapshot.settings?.thoughtLevel?.available || [];
    const thoughtLevel = snapshot.settings?.thoughtLevel?.current || session.model?.options?.reasoningLevel;
    session.thoughtLevel = thoughtLevel;
    if (session.thoughtLevels.length && thoughtLevel) configOptions.push({
      id: 'thought_level', name: 'Reasoning', category: 'thought_level', type: 'select',
      currentValue: thoughtLevel, options: session.thoughtLevels.map(level => ({ value: level.value, name: level.label })),
    });
    return {
      modes: { currentModeId: session.mode, availableModes: modes },
      ...(currentModelId ? { models: { currentModelId, availableModels } } : {}), configOptions,
    };
  }

  modelId(session, ref) {
    return `${ref.providerId}/${ref.modelId}`;
  }

  async open(params, load = false, replay = true) {
    const workspace = await this.workspace(params.cwd);
    const mcpServers = this.mcpServers(params.mcpServers);
    if (load && (typeof params.sessionId !== 'string' || !params.sessionId)) throw fault('sessionId is required');
    if (load && this.sessions.has(params.sessionId)) throw fault('Session is already open', -32000);
    await this.prepare();
    const saved = load ? await this.metadata.read(params.sessionId) : null;
    if (saved && saved.cwd !== params.cwd) throw fault('Loaded session belongs to a different directory');
    let snapshot;
    let recreated = false;
    const create = () => this.runtime.call('session/create', {
      workspace, mcpServers, mode: saved?.mode || 'build', persistence: 'immediate', titleGenerationEnabled: false,
    });
    if (!load) snapshot = await create();
    else {
      try { snapshot = await this.runtime.call('session/resume', { workspace, mcpServers, sessionId: saved?.nativeId || params.sessionId }); }
      catch (error) {
        // Recreate only metadata-owned sessions that have never received a
        // prompt. Missing/uncertain native conversation history stays an error.
        if (!saved || saved.everPrompted || !/^Session not found:/i.test(error.message)) throw error;
        snapshot = await create();
        recreated = true;
      }
    }
    const nativeId = snapshot.session?.sessionId;
    if (typeof nativeId !== 'string' || !nativeId) throw fault('ZCode returned no session ID', -32603);
    const id = load ? params.sessionId : nativeId;
    if (load && snapshot.session.workspace?.workspacePath !== workspace.workspacePath) {
      await this.runtime.call('session/close', { sessionId: nativeId });
      throw fault('Loaded session belongs to a different directory');
    }
    const session = { id, nativeId, cwd: params.cwd, lastSeq: 0, tools: new Map(), turn: null, mutating: false,
      planEnabled: !recreated && saved?.mode === 'plan',
      everPrompted: saved?.everPrompted ?? (load && !recreated), createdAt: saved?.createdAt || new Date().toISOString() };
    this.sessions.set(id, session);
    let state = this.state(session, snapshot);
    try {
      const restoreEmptySettings = saved && !saved.everPrompted;
      if (restoreEmptySettings && saved.model && JSON.stringify(saved.model) !== JSON.stringify(session.model)) {
        snapshot = await this.runtime.call('session/setModel', { sessionId: nativeId, model: saved.model, persistAsWorkspaceLastUsed: false });
        state = this.state(session, snapshot);
      }
      if (restoreEmptySettings && saved.mode && (saved.mode === 'plan' || saved.mode !== session.mode)) {
        snapshot = await this.runtime.call('session/setMode', { sessionId: nativeId, mode: saved.mode });
        session.planEnabled = saved.mode === 'plan';
        state = this.state(session, snapshot);
      }
      if (restoreEmptySettings && saved.thoughtLevel && saved.thoughtLevel !== session.thoughtLevel) {
        snapshot = await this.runtime.call('session/setThoughtLevel', { sessionId: nativeId, thoughtLevel: saved.thoughtLevel });
        state = this.state(session, snapshot);
      }
      await this.runtime.call('session/subscribe', { sessionId: nativeId, deliveryKind: 'desktop-continuous', includeSnapshot: false });
      if (load && replay) this.replay(session, snapshot.messages || []);
      await this.metadata.write(session);
      return { sessionId: id, ...state };
    } catch (error) {
      this.sessions.delete(id);
      await this.runtime.call('session/close', { sessionId: nativeId }).catch(() => {});
      throw error;
    }
  }

  replay(session, messages) {
    for (const message of messages) {
      if (message.info?.visibility === 'model-only' || message.info?.semantics?.uiVisibility === 'hidden') continue;
      for (const part of message.parts || []) {
        if (part.type === 'text' || part.type === 'reasoning') {
          const role = message.info?.role;
          if (role !== 'assistant' && role !== 'user') continue;
          this.update(session, {
            sessionUpdate: role === 'user' ? 'user_message_chunk' : part.type === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk',
            content: textContent(part.text || ''), messageId: message.info?.messageId,
          });
        } else if (part.type === 'tool') {
          this.update(session, { sessionUpdate: 'tool_call', toolCallId: part.callId, title: part.tool,
            kind: toolKind(part.tool), rawInput: part.state?.input,
            status: part.state?.status === 'error' ? 'failed' : part.state?.status === 'completed' ? 'completed' : 'pending',
            ...(part.state?.output ? { content: toolContent(part.state.output) } : {}),
          });
        }
      }
    }
  }

  promptText(prompt) {
    if (!Array.isArray(prompt)) throw fault('prompt must be an ACP content block array');
    return prompt.map(block => {
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      if (block?.type === 'resource' && typeof block.resource?.text === 'string') {
        return `${block.resource.uri || 'Resource'}\n${block.resource.text}`;
      }
      if (block?.type === 'resource_link' && typeof block.uri === 'string') return `${block.name || 'Resource'}: ${block.uri}`;
      throw fault(`Unsupported prompt content: ${block?.type || 'unknown'}`);
    }).join('\n');
  }

  async prompt(session, params) {
    const content = this.promptText(params.prompt);
    if (!content.trim()) throw fault('Prompt is empty');
    const inputId = randomUUID();
    let resolve, reject;
    const complete = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Register before the send acknowledgement: a fast turn may finish first.
    session.turn = { inputId, resolve, reject, text: '', cancelRequested: false };
    const turn = session.turn;
    const admission = (async () => {
      const previouslyPrompted = session.everPrompted;
      session.everPrompted = true;
      await this.metadata.write(session);
      if (session.turn !== turn || turn.cancelRequested || session.closing || this.closed) {
        if (session.turn === turn) {
          session.everPrompted = previouslyPrompted;
          await this.metadata.write(session);
          if (session.turn === turn) this.finish(session, { stopReason: 'cancelled' });
        }
        return { accepted: true };
      }
      return this.runtime.call('session/send', { sessionId: session.nativeId, content, inputId });
    })().then(result => {
      if (result?.accepted !== true) throw fault('ZCode did not accept the prompt', -32603);
    }).catch(error => { if (session.turn === turn) this.finish(session, undefined, error); throw error; });
    const [result] = await Promise.all([complete, admission]);
    return result;
  }

  finish(session, result, error) {
    const turn = session.turn;
    if (!turn) return;
    session.turn = null;
    clearTimeout(turn.cancelTimer);
    for (const [id, entry] of this.clientRequests) {
      if (entry.sessionId === session.id) {
        this.clientRequests.delete(id);
        entry.resolve({ outcome: { outcome: 'cancelled' } });
      }
    }
    if (error) turn.reject(error);
    else turn.resolve(result);
  }

  async cancel(session) {
    if (!session.turn || session.turn.cancelRequested) return {};
    session.turn.cancelRequested = true;
    for (const [id, entry] of this.clientRequests) {
      if (entry.sessionId === session.id) {
        this.clientRequests.delete(id);
        entry.resolve({ outcome: { outcome: 'cancelled' } });
      }
    }
    session.turn.cancelTimer = setTimeout(() => {
      // Killing the runtime prevents an unacknowledged cancellation from
      // leaving commands executing after the client thinks the turn ended.
      this.runtime.fail(fault('ZCode cancellation did not complete', -32603));
    }, cancelTimeout);
    await this.runtime.call('session/stop', { sessionId: session.nativeId });
    return {};
  }

  async configure(session, kind, value) {
    session.mutating = true;
    try {
      let snapshot;
      if (kind === 'mode') {
        if (!modes.some(mode => mode.id === value)) throw fault(`Unknown mode: ${value}`);
        snapshot = await this.runtime.call('session/setMode', { sessionId: session.nativeId, mode: value });
        // Native v1 snapshots report the base permission mode; plan is an
        // independent execution-state flag, applied by the same setMode RPC.
        session.planEnabled = value === 'plan';
      } else if (kind === 'model') {
        // Legacy plain IDs remain usable only when they cannot choose a different
        // plan accidentally. Advertised IDs always include their provider.
        const matches = session.models.filter(model => this.modelId(session, model.ref) === value || model.ref.modelId === value);
        if (matches.length !== 1) throw fault(`Unknown or ambiguous model: ${value}`);
        const selected = matches[0];
        const currentReasoning = session.model?.options?.reasoningLevel;
        const reasoning = selected.reasoning?.levels?.some(level => level.value === currentReasoning)
          ? currentReasoning : selected.reasoning?.defaultLevel;
        const model = reasoning ? { ...selected.ref, options: { ...selected.ref.options, reasoningLevel: reasoning } } : selected.ref;
        snapshot = await this.runtime.call('session/setModel', {
          sessionId: session.nativeId, model, persistAsWorkspaceLastUsed: false,
        });
      } else if (kind === 'thought_level') {
        if (!session.thoughtLevels.some(level => level.value === value)) throw fault(`Unknown reasoning level: ${value}`);
        snapshot = await this.runtime.call('session/setThoughtLevel', { sessionId: session.nativeId, thoughtLevel: value });
      } else throw fault(`Unknown configuration option: ${kind}`);
      const state = this.state(session, snapshot);
      await this.metadata.write(session);
      this.update(session, { sessionUpdate: 'current_mode_update', currentModeId: session.mode });
      this.update(session, { sessionUpdate: 'config_option_update', configOptions: state.configOptions });
      return { configOptions: state.configOptions };
    } finally { session.mutating = false; }
  }

  async dispatch(method, params) {
    switch (method) {
      case 'initialize':
        if (params.protocolVersion !== 1) throw fault('ACP protocol version 1 is required');
        return { protocolVersion: 1, agentInfo: { name: 'ZCode ACP Bridge', version: '1.0.0' },
          agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true },
            sessionCapabilities: { list: {}, close: {}, resume: {} }, mcpCapabilities: { http: true, sse: true } },
          authMethods: [] };
      case 'session/new': return this.open(params);
      case 'session/load': {
        const result = await this.open(params, true);
        const { sessionId, ...state } = result;
        return state;
      }
      case 'session/resume': return this.open(params, true, false);
      case 'session/list': {
        if (params.cursor) throw fault('This provider does not use pagination cursors');
        await this.prepare();
        const result = await this.runtime.call('session/list', params.cwd ? { workspace: await this.workspace(params.cwd) } : {});
        const records = await this.metadata.list(params.cwd);
        const aliases = new Map(records.map(record => [record.nativeId, record.id]));
        const sessions = new Map((result.sessions || []).map(session => ({ sessionId: aliases.get(session.sessionId) || session.sessionId,
          cwd: session.workspace.workspacePath, title: session.title,
          updatedAt: new Date(session.updatedAt).toISOString() })).map(session => [session.sessionId, session]));
        for (const record of records) if (!record.everPrompted && !sessions.has(record.id)) {
          sessions.set(record.id, { sessionId: record.id, cwd: record.cwd, title: 'New ZCode session', updatedAt: record.updatedAt });
        }
        return { sessions: [...sessions.values()] };
      }
      case 'session/prompt': return this.prompt(this.session(params, true), params);
      case 'session/set_mode': await this.configure(this.session(params, true), 'mode', params.modeId); return {};
      case 'session/set_model': await this.configure(this.session(params, true), 'model', params.modelId); return {};
      case 'session/set_config_option': return this.configure(this.session(params, true), params.configId, params.value);
      case 'session/cancel': return this.cancel(this.session(params));
      case 'session/close': {
        const session = this.sessions.get(params.sessionId);
        if (!session) throw fault(`Session not found: ${params.sessionId}`);
        if (session.mutating) throw fault('Session is busy', -32000);
        if (session.closing) throw fault('Session is closing', -32000);
        session.closing = true;
        if (!session.invalid) {
          await this.cancel(session);
          await this.runtime.call('session/close', { sessionId: session.nativeId });
        }
        this.finish(session, { stopReason: 'cancelled' });
        this.sessions.delete(session.id);
        return {};
      }
      case 'authenticate': throw fault('Authenticate with the installed ZCode login command', -32601);
      default: throw fault(`Method not found: ${method}`, -32601);
    }
  }

  event(msg) {
    if (msg.method === 'state.updated') {
      const change = msg.params;
      const session = this.nativeSession(change?.sessionId);
      if (session?.turn && change.reason === 'prompt_failed') {
        const turn = session.turn;
        // Early initialization failures may never produce a turn event.
        void this.runtime.call('session/read', { sessionId: session.nativeId }).then(snapshot => {
          if (session.turn !== turn) return;
          const error = snapshot.runtime?.lastError || snapshot.projection?.lastError;
          this.finish(session, undefined, fault(error?.message || 'ZCode prompt failed before completion', -32603));
        }).catch(error => { if (session.turn === turn) this.finish(session, undefined, error); });
      }
      return;
    }
    if (msg.method !== 'session/event') return;
    const event = msg.params;
    const session = this.nativeSession(event?.sessionId);
    if (!session || session.invalid) return;
    if (Number.isSafeInteger(event.seq)) {
      if (event.seq <= session.lastSeq) return;
      session.lastSeq = event.seq;
    }
    const payload = event.payload || {};
    const turn = session.turn;
    if (event.type === 'session.updated' && typeof payload.planEnabled === 'boolean') {
      session.planEnabled = payload.planEnabled;
      const snapshot = { ...session.snapshot, settings: { ...session.snapshot.settings,
        mode: { current: payload.mode || session.snapshot.settings?.mode?.current || 'build' } } };
      const state = this.state(session, snapshot);
      this.update(session, { sessionUpdate: 'current_mode_update', currentModeId: session.mode });
      this.update(session, { sessionUpdate: 'config_option_update', configOptions: state.configOptions });
      void this.metadata.write(session).catch(() => process.stderr.write('Unable to persist ACP session settings\n'));
      return;
    }
    if (event.type === 'turn.started' && turn) turn.id = event.turnId;
    if (event.turnId && turn?.id && event.turnId !== turn.id) return;
    if (payload.inputId && turn && payload.inputId !== turn.inputId) return;
    if (event.type === 'model.streaming' && turn) {
      if ((payload.kind === 'text_delta' || payload.kind === 'reasoning_delta') && typeof payload.delta === 'string') {
        if (payload.kind === 'text_delta') turn.text += payload.delta;
        this.update(session, { sessionUpdate: payload.kind === 'text_delta' ? 'agent_message_chunk' : 'agent_thought_chunk',
          content: textContent(payload.delta), ...(payload.assistantMessageId ? { messageId: payload.assistantMessageId } : {}) });
      } else if (payload.toolCallId && ['tool_input_start', 'tool_input_delta', 'tool_input_end', 'tool_call'].includes(payload.kind)) {
        const previous = session.tools.get(payload.toolCallId) || {};
        const inputText = (previous.inputText || '') + (payload.kind === 'tool_input_delta' ? payload.delta || '' : '');
        let input = payload.input;
        if (input === undefined && inputText) {
          try { input = JSON.parse(inputText); } catch { input = inputText; }
        }
        this.tool(session, { kind: 'scheduled', toolCallId: payload.toolCallId,
          toolName: payload.toolName, ...(input !== undefined ? { input } : {}) });
        session.tools.get(payload.toolCallId).inputText = inputText;
      }
    } else if (event.type === 'tool.updated' && turn) {
      this.tool(session, payload);
    } else if (event.type === 'turn.completed' && turn) {
      const type = payload.resultType;
      if (!turn.text && payload.response) this.update(session, { sessionUpdate: 'agent_message_chunk', content: textContent(payload.response) });
      if (type === 'success') this.finish(session, { stopReason: 'end_turn' });
      else if (type === 'cancelled') this.finish(session, { stopReason: 'cancelled' });
      else if (type === 'error_max_turns' || type === 'error_max_tool_calls') this.finish(session, { stopReason: 'max_turn_requests' });
      else this.finish(session, undefined, fault(`ZCode turn failed: ${type || 'unknown result'}`, -32603));
    } else if (event.type === 'turn.failed' && turn) {
      this.finish(session, undefined, fault(payload.error?.message || 'ZCode turn failed', -32603));
    } else if (event.type === 'session.closed') {
      session.invalid = true;
      this.finish(session, { stopReason: 'cancelled' });
    }
  }

  tool(session, payload) {
    if (!payload.toolCallId) return;
    const id = payload.toolCallId;
    const previous = session.tools.get(id);
    const title = payload.toolName || previous?.title || 'ZCode tool';
    const status = ({ scheduled: 'pending', started: 'in_progress', progress: 'in_progress', result: 'completed', error: 'failed' })[payload.kind];
    if (!status) return;
    const update = { sessionUpdate: previous ? 'tool_call_update' : 'tool_call', toolCallId: id,
      title, kind: toolKind(title), status };
    if (own(payload, 'input')) update.rawInput = payload.input;
    if (payload.kind === 'result') {
      update.rawOutput = payload.result;
      if (payload.result?.success === false || payload.result?.isError === true) update.status = 'failed';
      const output = payload.result?.output ?? payload.result?.content;
      if (typeof output === 'string') update.content = toolContent(output);
    }
    if (payload.kind === 'error') {
      update.rawOutput = payload.error;
      update.content = toolContent(payload.error?.message || 'Tool execution failed');
    }
    if (payload.kind === 'progress' && payload.outputPreview) update.content = toolContent(typeof payload.outputPreview === 'string' ? payload.outputPreview : JSON.stringify(payload.outputPreview));
    session.tools.set(id, { ...previous, title });
    this.update(session, update);
  }

  async reverse(msg, runtime) {
    if (msg.method === 'interaction/requestProviderRuntimeHeaders') {
      try { runtime.reply(msg.id, await requestAuth(accountPaths, msg.params || {}, accountEnv)); }
      catch (error) { runtime.reply(msg.id, { headersApplied: false, errorMessage: error.message }); }
      return;
    }
    if (msg.method === 'interaction/requestUserInput') {
      runtime.reply(msg.id, { action: 'cancel', reason: 'Interactive questions are unavailable in this ACP client' });
      return;
    }
    if (msg.method !== 'interaction/requestPermission') {
      // ZCode handles -32601 with its native runtime-preference fallback.
      runtime.reply(msg.id, undefined, { code: -32601, message: `Unsupported client method: ${msg.method}` });
      return;
    }
    const params = msg.params || {};
    const session = this.nativeSession(params.sessionId);
    if (!session?.turn || session.turn.cancelRequested || session.closing) {
      runtime.reply(msg.id, { decision: 'deny', reason: 'Session is inactive or cancelled' });
      return;
    }
    const options = (params.options || []).map(option => ({ ...option,
      kind: ({ deny: 'reject_once', allow_session: 'allow_always', allowOnce: 'allow_once', allowAlways: 'allow_always' })[option.kind] || option.kind,
    })).filter(option => ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind));
    if (!options.length) { runtime.reply(msg.id, { decision: 'deny', reason: 'No compatible permission options' }); return; }
    const id = `client:${++this.nextClientId}`;
    const result = await new Promise(resolve => {
      this.clientRequests.set(id, { sessionId: session.id, resolve });
      this.write({ id, method: 'session/request_permission', params: {
        sessionId: session.id, options: options.map(({ optionId, kind, name }) => ({ optionId, kind, name })),
        toolCall: { toolCallId: params.toolCallId, title: params.toolName || 'ZCode tool',
          kind: toolKind(params.toolName || ''), status: 'pending', rawInput: params.input,
          content: toolContent(params.reason || 'Permission required') },
      } });
    });
    const selected = result?.outcome?.outcome === 'selected' && options.find(option => option.optionId === result.outcome.optionId);
    runtime.reply(msg.id, selected?.response || { decision: 'deny', reason: 'Permission request cancelled or rejected' });
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions.values()) this.finish(session, { stopReason: 'cancelled' });
    await this.runtime.stop();
  }
}

export function main() {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write('ZCode ACP Bridge 1.0.0\n');
    return;
  }
  const bridge = new Bridge();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    if (!line.trim() || bridge.closed) return;
    let message;
    try { message = JSON.parse(line); }
    catch { bridge.reply(null, undefined, fault('Parse error', -32700)); return; }
    void bridge.receive(message);
  });
  const shutdown = () => { lines.close(); void bridge.stop(); };
  lines.on('close', () => { void bridge.stop(); });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.stdout.on('error', shutdown);
  return bridge;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
