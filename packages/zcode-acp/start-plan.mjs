// Read-only account entitlement lookup using this installation's real identity.
// No claim, token refresh, device creation or CAPTCHA handling occurs here.
import { open, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const origin = 'https://zcode.z.ai';
export async function desktopVersion(env) {
  const file = await open(env.ZCODE_ACP_DESKTOP_ASAR || '/opt/ZCode/resources/app.asar', 'r');
  try {
    const prefix = Buffer.alloc(16);
    await file.read(prefix, 0, 16, 0);
    const size = prefix.readUInt32LE(12);
    if (size < 2 || size > 16 * 1024 * 1024) throw new Error('Invalid ZCode desktop archive');
    const header = Buffer.alloc(size);
    await file.read(header, 0, size, 16);
    const entry = JSON.parse(header).files?.out?.files?.metadata?.files?.['build-meta.json'];
    if (!entry || entry.size > 1024 * 1024 || !/^\d+$/.test(entry.offset)) throw new Error('Invalid ZCode desktop metadata');
    const payload = Buffer.alloc(entry.size);
    await file.read(payload, 0, payload.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
    const version = JSON.parse(payload).appVersion;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error('Invalid ZCode desktop version');
    return version;
  } finally { await file.close(); }
}

export async function startPlanContext(paths, env = process.env) {
  const appVersion = await desktopVersion(env);
  const telemetry = JSON.parse(await readFile(path.join(path.dirname(paths.credentials), 'telemetry-state.json'), 'utf8'));
  const deviceMid = telemetry.deviceMid?.trim();
  if (!deviceMid) throw new Error('ZCode device identity unavailable; open the installed ZCode app');
  const locale = Intl.DateTimeFormat().resolvedOptions();
  return { appVersion, headers: {
    'HTTP-Referer': origin, 'User-Agent': `ZCode/${appVersion}`,
    'X-ZCode-App-Version': appVersion, 'X-Title': 'Z Code@paseo-acp',
    'X-Platform': `${process.platform}-${process.arch}`,
    'X-Client-Language': locale.locale, 'X-Client-Timezone': locale.timeZone,
    'X-Os-Category': process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    'X-Os-Version': os.release(), 'X-Device-Mid': deviceMid,
  } };
}

export function startPlanBalance(envelope, serverDate) {
  if (!envelope || envelope.success === false || ![undefined, 0, 200].includes(envelope.code)) {
    return { availability: 'unavailable', models: [], plans: [], code: typeof envelope?.code === 'number' ? envelope.code : undefined };
  }
  const data = envelope.data || {};
  const date = Date.parse(serverDate);
  const now = Number.isFinite(date) ? date / 1000 : typeof data.server_time === 'number' ? data.server_time : Date.now() / 1000;
  const plans = (Array.isArray(data.plans) ? data.plans : []).map(plan => {
    const end = Number(plan.ends_at);
    return { ...plan, status: Number.isFinite(end) && end > 0 && end <= now ? 'expired' : plan.status };
  });
  const active = plans.filter(plan => {
    const id = `${plan.plan_id || ''} ${plan.name || ''}`.toLowerCase();
    return plan.status?.trim().toLowerCase() === 'active' &&
      ((!plan.plan_id && !plan.name) || id.includes('start-plan') || id.includes('start plan'));
  });
  if (!active.length) return { availability: 'unavailable', models: [], plans: [] };
  const models = new Map(), modelBenefits = {}, modelDescriptions = {};
  for (const balance of Array.isArray(data.balances) ? data.balances : []) {
    const owners = plans.filter(plan => balance.user_plan_id && plan.user_plan_id
      ? balance.user_plan_id === plan.user_plan_id : balance.plan_id === plan.plan_id);
    if (owners.length && !owners.some(plan => plan.status?.toLowerCase() !== 'expired')) continue;
    const capabilities = (Array.isArray(balance.capabilities) ? balance.capabilities : [])
      .filter(value => typeof value === 'string' && /^model:/i.test(value.trim())).map(value => value.trim().slice(6).trim()).filter(Boolean);
    for (const value of capabilities.length ? capabilities : [balance.show_name]) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const model = value.trim().replace(/^glm-/i, 'GLM-').replace(/-flash$/i, '-Flash').replace(/-turbo$/i, '-Turbo');
      models.set(model.toLowerCase(), model);
      modelBenefits[model] = [...new Set([...(modelBenefits[model] || []), ...owners.filter(plan => active.includes(plan)).map(plan => plan.name || 'Start Plan')])];
      modelDescriptions[model] = active.filter(plan => modelBenefits[model].includes(plan.name || 'Start Plan')).map(plan => {
        const ends = Number(plan.ends_at);
        return `${plan.name || 'Start Plan'}${Number.isFinite(ends) && ends > 0 ? ` (expires ${new Date(ends * 1000).toISOString()})` : ''}`;
      }).join(' + ');
    }
  }
  const effective = active.flatMap(plan => plan.entitlements?.length ? plan.entitlements.map(entitlement => entitlement.effective_at) : [plan.starts_at]).map(value => value == null || value === '' ? NaN : Number(value));
  const pending = !models.size && effective.length > 0 && effective.every(value => Number.isFinite(value) && value > now);
  return {
    availability: pending ? 'pending' : 'available', models: [...models.values()], modelBenefits, modelDescriptions,
    plans: active.map(plan => ({ name: plan.name || 'Start Plan', endsAt: Number(plan.ends_at) || null })),
  };
}

export async function lookupStartPlan(paths, jwt, env = process.env) {
  try {
    const context = await startPlanContext(paths, env);
    const url = new URL('/api/v1/zcode-plan/billing/balance', origin);
    url.searchParams.set('app_version', context.appVersion);
    const response = await fetch(url, {
      method: 'GET', headers: { ...context.headers, Authorization: `Bearer ${jwt}` },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { availability: response.status === 401 || response.status === 403 ? 'unavailable' : 'unknown', models: [], plans: [], httpStatus: response.status };
    return startPlanBalance(await response.json(), response.headers.get('date'));
  } catch { return { availability: 'unknown', models: [], plans: [] }; }
}
