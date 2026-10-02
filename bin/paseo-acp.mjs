#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, open, rm, lstat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { discoverZcode, executable, isFile, userPath } from '../lib/runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = userPath(process.env.PASEO_HOME || path.join(os.homedir(), '.paseo'));
const configFile = path.join(home, 'config.json');
const receiptFile = path.join(home, 'paseo-acp-installation.json');
const transactionFile = path.join(home, '.paseo-acp-transaction.json');
const ids = { antigravity: 'choratools-antigravity', zcode: 'choratools-zcode' };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const equals = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function usage() {
  console.log(`Paseo ACP 0.1.0 — community Antigravity and ZCode adapters

Usage: paseo-acp <command> [--provider all|antigravity|zcode]

  doctor       Locate local agent runtimes; no model requests
  setup        Back up and add community providers to Paseo
  login        Launch the selected native CLI's interactive login
  uninstall    Remove unchanged provider entries created by setup
  antigravity  Serve Antigravity ACP over stdio
  zcode        Serve ZCode ACP over stdio

Examples:
  paseo-acp doctor
  paseo-acp setup --provider all
  paseo-acp login --provider zcode

Start Plan and Trust Build use an existing ZCode account login.
No vendor runtimes or credentials are included in this package.`);
}
function options(args) {
  let provider = 'all';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--provider' && args[index + 1]) provider = args[++index];
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (!['all', ...Object.keys(ids)].includes(provider)) throw new Error('Provider must be all, antigravity, or zcode');
  return provider === 'all' ? Object.keys(ids) : [provider];
}
async function json(file, fallback) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!object(value)) throw new Error('Invalid object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${path.basename(file)} as JSON; leaving it unchanged`);
  }
}
async function locate(provider, required = true) {
  if (provider === 'zcode') return discoverZcode(process.env, required);
  const command = await executable(process.env.AGY_ACP_COMMAND || 'agy');
  if (!command && required) throw new Error('Antigravity CLI not found. Install Antigravity and add agy to PATH, or set AGY_ACP_COMMAND.');
  return { available: Boolean(command), command };
}
const serialize = value => `${JSON.stringify(value, null, 2)}\n`;
const configHash = text => text === null ? null : createHash('sha256').update(text).digest('hex');
async function optionalText(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicText(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text);
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, file);
  } finally { if (handle) await handle.close(); await rm(temporary, { force: true }); }
}
async function atomic(file, value) { await atomicText(file, serialize(value)); }
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;
function livePid(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
async function acquireLock(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let before;
      try { before = await lstat(file); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      let owner;
      try { owner = JSON.parse(await readFile(file, 'utf8')); } catch {}
      const validPid = Number.isSafeInteger(owner?.pid) && owner.pid > 0;
      const stale = validPid ? !livePid(owner.pid) : Date.now() - before.mtimeMs >= 30_000;
      if (!stale) throw new Error(`Another setup operation holds ${file}; finish it before retrying`);
      try {
        if (!sameFile(before, await lstat(file))) continue;
        await rm(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      continue;
    }
    try {
      await handle.writeFile(serialize({ pid: process.pid, token: randomUUID() }));
      await handle.sync();
      const owned = await handle.stat();
      return { async release() {
        try {
          const current = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (current && sameFile(owned, current)) await rm(file, { force: true });
        } finally { await handle.close(); }
      } };
    } catch (error) {
      const owned = await handle.stat();
      await handle.close();
      const current = await lstat(file).catch(() => null);
      if (current && sameFile(owned, current)) await rm(file, { force: true });
      throw error;
    }
  }
  throw new Error(`Setup lock changed during acquisition: ${file}; retry the command`);
}
async function recoverTransaction() {
  const transaction = await json(transactionFile, null);
  if (!transaction) return;
  const validHash = hash => hash === null || typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
  if (transaction.schemaVersion !== 1 || !validHash(transaction.beforeConfigHash) || !validHash(transaction.afterConfigHash)
      || !object(transaction.beforeProviders) || !object(transaction.afterProviders)) {
    throw new Error('Invalid installation transaction; configuration and receipt were left unchanged');
  }
  const hash = configHash(await optionalText(configFile));
  const providers = hash === transaction.afterConfigHash ? transaction.afterProviders
    : hash === transaction.beforeConfigHash ? transaction.beforeProviders : null;
  if (!providers) throw new Error('Paseo configuration was externally edited during an interrupted installation; preserving it and the recovery transaction');
  const receipt = await json(receiptFile, { schemaVersion: 1, providers: {} });
  if (!equals(receipt.providers, transaction.beforeProviders) && !equals(receipt.providers, transaction.afterProviders)) {
    throw new Error('Installation receipt was externally edited; preserving it and the recovery transaction');
  }
  if (configHash(await optionalText(configFile)) !== hash) throw new Error('Paseo configuration changed during recovery; leaving the recovery transaction for retry');
  await atomic(receiptFile, { ...receipt, providers });
  await rm(transactionFile);
}
async function configure(selected, uninstall) {
  const runtimes = new Map();
  if (!uninstall) for (const provider of selected) runtimes.set(provider, await locate(provider));
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lockFile = path.join(home, '.paseo-acp-setup.lock');
  const lock = await acquireLock(lockFile);
  try {
    await recoverTransaction();
    const original = await optionalText(configFile);
    const config = await json(configFile, {});
    const receipt = await json(receiptFile, { schemaVersion: 1, providers: {} });
    if (!object(receipt.providers)) throw new Error('Invalid setup receipt; configuration was not changed');
    const beforeProviders = structuredClone(receipt.providers);
    if (config.agents !== undefined && !object(config.agents)) throw new Error('agents must be an object');
    config.agents ||= {};
    if (config.agents.providers !== undefined && !object(config.agents.providers)) throw new Error('agents.providers must be an object');
    config.agents.providers ||= {};
    const changed = [];
    for (const provider of selected) {
      const id = ids[provider], current = config.agents.providers[id], installed = receipt.providers[id];
      if (uninstall) {
        if (!installed) continue;
        if (!equals(current, installed.entry)) throw new Error(`${id} was edited after setup; leaving your configuration unchanged`);
        if (installed.previous !== null) config.agents.providers[id] = installed.previous;
        else delete config.agents.providers[id];
        delete receipt.providers[id]; changed.push(id); continue;
      }
      if (current !== undefined && (!installed || !equals(current, installed.entry))) throw new Error(`${id} already exists and is not owned by this setup; leaving configuration unchanged`);
      const runtime = runtimes.get(provider);
      const env = provider === 'antigravity'
        ? { AGY_ACP_COMMAND: path.resolve(runtime.command),
          ...(process.env.AGY_ACP_ALLOW_UNSAFE !== undefined ? { AGY_ACP_ALLOW_UNSAFE: process.env.AGY_ACP_ALLOW_UNSAFE } : {}) }
        : { ZCODE_ACP_RUNTIME: userPath(runtime.runtimePath), ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: userPath(runtime.builtinPath),
          ...(runtime.desktopAsar ? { ZCODE_ACP_DESKTOP_ASAR: userPath(runtime.desktopAsar) } : {}),
          ...Object.fromEntries(['ZCODE_DATA_BASE_DIR', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'].flatMap(key => {
            const value = process.env[key]?.trim();
            return value ? [[key, userPath(value)]] : [];
          })) };
      const entry = { extends: 'acp', label: provider === 'zcode' ? 'ZCode (community ACP)' : 'Antigravity (community ACP)', enabled: true,
        command: [process.execPath, path.join(root, 'bin/paseo-acp.mjs'), provider], env };
      receipt.providers[id] = { previous: installed ? installed.previous : current ?? null, entry };
      if (!equals(current, entry)) changed.push(id);
      config.agents.providers[id] = entry;
    }
    if (!changed.length) { console.log(uninstall ? 'No managed providers to remove.' : 'Selected providers are already configured.'); return; }
    let backup = null;
    if (original !== null) {
      const directory = path.join(home, 'backups'); await mkdir(directory, { recursive: true, mode: 0o700 });
      backup = path.join(directory, `config.${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID()}.json`);
      await writeFile(backup, original, { mode: 0o600, flag: 'wx' });
    }
    const latest = await optionalText(configFile);
    if (latest !== original) throw new Error('Paseo configuration changed during setup; retry the command');
    const nextConfig = serialize(config);
    await atomic(transactionFile, { schemaVersion: 1, beforeConfigHash: configHash(original), afterConfigHash: configHash(nextConfig),
      beforeProviders, afterProviders: receipt.providers });
    if (await optionalText(configFile) !== original) throw new Error('Paseo configuration changed during setup; preserving it and the recovery transaction');
    await atomicText(configFile, nextConfig);
    if (configHash(await optionalText(configFile)) !== configHash(nextConfig)) throw new Error('Paseo configuration changed during installation; preserving it and the recovery transaction');
    await atomic(receiptFile, receipt);
    await rm(transactionFile);
    console.log(`${uninstall ? 'Removed' : 'Configured'}: ${changed.join(', ')}`);
    console.log(`Configuration: ${configFile}`);
    if (backup) console.log(`Backup: ${backup}`);
    console.log('Run paseo reload on this daemon host, then create a new agent.');
  } finally { await lock.release(); }
}
async function login(selected) {
  if (selected.length !== 1) throw new Error('Choose --provider antigravity or --provider zcode for login');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Login requires an interactive terminal');
  const provider = selected[0], runtime = await locate(provider);
  const command = provider === 'zcode' ? process.execPath : runtime.command;
  const args = provider === 'zcode' ? [runtime.runtimePath, 'login'] : [];
  if (provider === 'zcode') console.log('Native coding-plan login. For Start Plan/Trust Build, you can also sign in through the installed ZCode desktop app.');
  const env = provider === 'zcode' ? { ...process.env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: runtime.builtinPath, ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: runtime.builtinPath } : process.env;
  const child = spawn(command, args, { stdio: 'inherit', env });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
  process.exitCode = code;
}
async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) { usage(); return; }
  if (['--version', '-v'].includes(command)) { console.log('0.1.0'); return; }
  if (command === 'zcode' || command === 'antigravity') {
    if (args.length) throw new Error('ACP serve commands do not accept arguments; configure paths with environment variables');
    const adapter = await import(`../packages/${command}-acp/bridge.mjs`); await adapter.main(); return;
  }
  if (!['doctor', 'setup', 'uninstall', 'login'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const selected = options(args);
  if (command === 'doctor') {
    console.log(`Node ${process.version}; Paseo home: ${home}`);
    for (const provider of selected) {
      const runtime = await locate(provider, false);
      console.log(`${provider}: ${runtime.available ? 'runtime found' : 'not installed / not discovered'}`);
      if (runtime.command) console.log(`  command: ${runtime.command}`);
      if (runtime.runtimePath) console.log(`  runtime: ${runtime.runtimePath}`);
      if (runtime.builtinPath) console.log(`  providers: ${runtime.builtinPath}`);
      if (provider === 'zcode') {
        const credentials = path.join(userPath(process.env.ZCODE_DATA_BASE_DIR || os.homedir()), '.zcode/v2/credentials.json');
        console.log(`  desktop metadata: ${runtime.desktopAsar ? 'found' : 'not found (needed for Start Plan)'}`);
        console.log(`  credential file: ${await isFile(credentials) ? 'present; account/server acceptance not checked' : 'absent; run native login'}`);
      }
      if (!runtime.available) process.exitCode = 1;
    }
    return;
  }
  if (command === 'login') return login(selected);
  return configure(selected, command === 'uninstall');
}
main().catch(error => { console.error(`paseo-acp: ${error.message}`); process.exitCode = 1; });
