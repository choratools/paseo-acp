// Adapt the installed CLI and desktop account access without changing login,
// provider configuration or the vendor bundle. Secrets travel only to the local
// app-server's runtime-auth response, never into the account registry snapshot.
import { readFile } from 'node:fs/promises';
import { createHash, createDecipheriv } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { lookupStartPlan, desktopVersion } from './start-plan.mjs';

const resolveUserPath = value => value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(value);
export function providerPaths(runtimePath, env = process.env) {
  const baseDir = resolveUserPath(env.ZCODE_DATA_BASE_DIR || os.homedir());
  return {
    builtin: path.resolve(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || path.join(path.dirname(runtimePath), 'provider/zcode-builtin.json')),
    personal: path.resolve(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || path.join(baseDir, '.zcode/v2/provider_config.json')),
    credentials: path.join(baseDir, '.zcode/v2/credentials.json'),
  };
}

export function decryptCredential(value, env = process.env) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error('Invalid ZCode credential record');
  if (!value.startsWith('enc:v1:')) return value.trim();
  let username = 'unknown';
  try { username = os.userInfo().username; } catch {}
  const secret = env.ZCODE_CREDENTIAL_SECRET?.trim() || `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
  const key = createHash('sha256').update(secret).digest();
  try {
    const parts = value.slice('enc:v1:'.length).split('.');
    if (parts.length !== 3) throw new Error('Invalid encrypted credential');
    const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid credential cipher parameters');
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8').trim();
  } catch { throw new Error('Cannot decrypt ZCode credentials with the current account environment'); }
}

async function jsonFile(file, optional = false) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return {};
    // JSON parse exceptions can embed input bytes; keep secret-file failures generic.
    throw new Error(`Unable to read ZCode ${path.basename(file)}`);
  }
}

function apiKeyFromRecord(record, providerId, env) {
  const identity = decryptCredential(record[`account-provider:${providerId}:identity`], env);
  if (!identity) return '';
  return decryptCredential(record[`account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`], env);
}

function startPlanJwt(record, providerId, env) {
  const family = providerId === 'account:zai-start-plan' ? 'zai' : providerId === 'account:bigmodel-start-plan' ? 'bigmodel' : null;
  // Fresh native CLI login writes individual identity, but not necessarily a
  // Start-specific identity. The authenticated balance validates this JWT.
  if (!family || decryptCredential(record['oauth:active_provider'], env) !== family) return '';
  return decryptCredential(record.zcodejwttoken, env);
}

export async function accountSnapshot(paths, env = process.env) {
  const [builtin, personal, credentials] = await Promise.all([
    jsonFile(paths.builtin), jsonFile(paths.personal, true), jsonFile(paths.credentials, true),
  ]);
  const rules = builtin.config?.providerConfigRules;
  const entries = Array.isArray(rules) ? rules : rules?.providerRules;
  if (!Array.isArray(entries) || builtin.revision === undefined) throw new Error('Unsupported ZCode builtin provider configuration');
  const configuredModel = personal.config?.defaultModelSelection;
  const providers = {}, states = {}, labels = {}, planStates = {}, modelBenefits = {}, modelDescriptions = {};
  const eligible = entries.filter(rule =>
    rule.config?.access?.type === 'zhipu-account' && ['individual-coding-plan', 'start-plan'].includes(rule.config.access.mode) &&
    rule.config.access.accountType && Array.isArray(rule.config.builtinModelIds) && rule.config.builtinModelIds.length);
  for (const rule of eligible.filter(rule => rule.config.access.mode === 'start-plan')) {
    const jwt = startPlanJwt(credentials, rule.providerId, env);
    planStates[rule.providerId] = jwt ? await lookupStartPlan(paths, jwt, env) : { availability: 'unavailable', models: [], plans: [] };
  }
  const entitled = eligible.filter(rule => rule.config.access.mode === 'individual-coding-plan' && apiKeyFromRecord(credentials, rule.providerId, env));
  const currentProvider = entitled.find(rule => rule.providerId === configuredModel?.providerId)?.providerId || entitled[0]?.providerId;
  for (const rule of eligible) {
    const plan = planStates[rule.providerId];
    const hasAccess = plan ? plan.availability === 'available' && plan.models.length > 0 : entitled.some(provider => provider.providerId === rule.providerId);
    providers[rule.providerId] = { access: { type: 'zhipu-account', entitled: hasAccess }, ...(plan ? { builtinModelIds: plan.models } : {}) };
    // Start Plan is classified as ordinary by the native selector. Individual
    // plans still require exactly one current account-plan connection.
    states[rule.providerId] = { availability: plan?.availability || 'unknown', entitled: hasAccess, current: hasAccess && (Boolean(plan) || rule.providerId === currentProvider) };
    labels[rule.providerId] = rule.providerName || rule.providerId;
    if (plan) modelBenefits[rule.providerId] = plan.modelBenefits || {};
    if (plan) modelDescriptions[rule.providerId] = plan.modelDescriptions || {};
  }
  const basedOnZCodeBuiltinRevision = `zcode-builtin:${builtin.revision}:${createHash('sha256').update(path.resolve(paths.builtin)).digest('hex')}`;
  // The digest contains no credential values or account identities.
  const revision = `acp-account:${createHash('sha256').update(JSON.stringify([basedOnZCodeBuiltinRevision, providers, states])).digest('hex')}`;
  let appVersion;
  try { if (env.ZCODE_ACP_DESKTOP_ASAR) appVersion = await desktopVersion(env); } catch {}
  return { config: { revision, basedOnZCodeBuiltinRevision, providers, states }, defaultModel: configuredModel, labels, planStates, modelBenefits, modelDescriptions, appVersion };
}

export async function requestAuth(paths, params, env = process.env) {
  const providerId = params.providerId;
  const mode = params.accountAccess?.mode;
  if (typeof providerId !== 'string' || !providerId.startsWith('account:') ||
      params.modelSelection?.providerId !== providerId || !['individual-coding-plan', 'start-plan'].includes(mode)) {
    throw new Error('Unsupported ZCode account authentication request');
  }
  const credentials = await jsonFile(paths.credentials, true);
  if (mode !== 'start-plan' && ['account:zai-start-plan', 'account:bigmodel-start-plan'].includes(providerId)) throw new Error('Unsupported ZCode account authentication request');
  if (mode === 'start-plan') {
    const apiKey = startPlanJwt(credentials, providerId, env);
    if (!apiKey) throw new Error('Start Plan requires a connected ZCode account; sign in with the installed ZCode app');
    if (params.reason === 'captcha-retry') throw new Error('Start Plan requires verification in the ZCode desktop app');
    return { headersApplied: true, requestAuth: { apiKey } };
  }
  const apiKey = apiKeyFromRecord(credentials, providerId, env);
  if (!apiKey) throw new Error('ZCode login credentials unavailable; run ZCode login');
  return { headersApplied: true, requestAuth: { apiKey } };
}
