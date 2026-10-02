import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { providerPaths, decryptCredential, accountSnapshot, requestAuth } from '../account.mjs';

const env = { ZCODE_CREDENTIAL_SECRET: 'test-only-credential-secret' };
function encrypt(value, secret = env.ZCODE_CREDENTIAL_SECRET) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${[iv, cipher.getAuthTag(), ciphertext].map(value => value.toString('base64url')).join('.')}`;
}
const rule = (providerId, access = { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai' }) => ({ providerId, config: { access, builtinModelIds: ['GLM-5.3'] } });
function credential(providerId, identity, apiKey) {
  return {
    ...(identity !== undefined ? { [`account-provider:${providerId}:identity`]: encrypt(identity) } : {}),
    ...(apiKey !== undefined ? { [`account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity ?? 'unlinked')}:api-key`]: encrypt(apiKey) } : {}),
  };
}
async function fixture(t, { rules = [], templateRules = [], credentials = {}, defaultModelSelection } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-account-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = providerPaths(join(dir, 'runtime.cjs'), {
    ZCODE_DATA_BASE_DIR: dir,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(dir, 'builtin.json'),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(dir, 'personal.json'),
  });
  await mkdir(dirname(paths.credentials), { recursive: true });
  await writeFile(paths.builtin, JSON.stringify({ schemaVersion: 1, revision: 30, config: { providerConfigRules: { templateRules, providerRules: rules } } }));
  await writeFile(paths.personal, JSON.stringify({ config: { defaultModelSelection } }));
  await writeFile(paths.credentials, JSON.stringify(credentials));
  return paths;
}

test('provider path overrides isolate configuration and credentials under the test data directory', () => {
  const paths = providerPaths('/fixture/runtime/zcode.cjs', {
    ZCODE_DATA_BASE_DIR: '/fixture/data', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/fixture/builtin.json', ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: '/fixture/personal.json',
  });
  assert.deepEqual(paths, { builtin: '/fixture/builtin.json', personal: '/fixture/personal.json', credentials: '/fixture/data/.zcode/v2/credentials.json' });
  assert.equal(providerPaths('/fixture/runtime/zcode.cjs', { ZCODE_DATA_BASE_DIR: '/fixture/data' }).builtin, '/fixture/runtime/provider/zcode-builtin.json');
});

test('AES GCM decryption rejects tampering, wrong secrets, and malformed cipher parameters', () => {
  const encrypted = encrypt('  fake-api-key  ');
  assert.equal(decryptCredential(encrypted, env), 'fake-api-key');
  const parts = encrypted.slice('enc:v1:'.length).split('.');
  const tag = Buffer.from(parts[1], 'base64url');
  tag[0] ^= 1;
  const tampered = `enc:v1:${parts[0]}.${tag.toString('base64url')}.${parts[2]}`;
  for (const value of [tampered, 'enc:v1:one.two', 'enc:v1:YQ.Yg.Yw']) {
    assert.throws(() => decryptCredential(value, env), /Cannot decrypt ZCode credentials/);
  }
  assert.throws(() => decryptCredential(encrypted, { ZCODE_CREDENTIAL_SECRET: 'wrong-secret' }), /Cannot decrypt ZCode credentials/);
  assert.equal(decryptCredential('  plain-test-key  ', env), 'plain-test-key');
  assert.equal(decryptCredential(undefined, env), '');
  assert.throws(() => decryptCredential({ apiKey: 'invalid' }, env), /Invalid ZCode credential record/);
});

test('snapshot entitlement requires matching identity and key and chooses exactly one entitled current provider', async t => {
  const paths = await fixture(t, {
    rules: [rule('account:a'), rule('account:b'), rule('account:c'), rule('account:d'), rule('account:e'), rule('custom:x', { type: 'api-key', mode: 'individual-coding-plan' })],
    credentials: {
      ...credential('account:a', 'alice@example.test', 'key-a'),
      ...credential('account:b', 'bob@example.test'),
      ...credential('account:c', undefined, 'unlinked-key-c'),
      ...credential('account:d', 'dan@example.test', '   '),
      ...credential('account:e', 'eve@example.test', 'key-e'),
    },
    defaultModelSelection: { providerId: 'account:b', modelId: 'GLM-5.3' },
  });
  const first = await accountSnapshot(paths, env);
  assert.deepEqual(Object.keys(first.config.providers), ['account:a', 'account:b', 'account:c', 'account:d', 'account:e']);
  assert.deepEqual(Object.fromEntries(Object.entries(first.config.states).map(([id, state]) => [id, state.entitled])), { 'account:a': true, 'account:b': false, 'account:c': false, 'account:d': false, 'account:e': true });
  assert.deepEqual(Object.entries(first.config.states).filter(([, state]) => state.current).map(([id]) => id), ['account:a']);
  assert.ok(first.config.revision.startsWith('acp-account:'));
  assert.equal(first.config.revision, (await accountSnapshot(paths, env)).config.revision);
  assert.doesNotMatch(JSON.stringify(first.config), /alice@example|eve@example|key-a|key-e|unlinked-key-c/);
  await writeFile(paths.personal, JSON.stringify({ config: { defaultModelSelection: { providerId: 'account:e', modelId: 'GLM-5.3' } } }));
  const preferred = await accountSnapshot(paths, env);
  assert.deepEqual(Object.entries(preferred.config.states).filter(([, state]) => state.current).map(([id]) => id), ['account:e']);
});

test('providers without credentials remain unentitled and none is current', async t => {
  const paths = await fixture(t, { rules: [rule('account:a'), rule('account:b')] });
  const snapshot = await accountSnapshot(paths, env);
  assert.ok(Object.values(snapshot.config.states).every(state => state.entitled === false && state.current === false));
});

test('template rules and account providers without account type or builtin models do not grant access', async t => {
  const missingModels = rule('account:no-models');
  missingModels.config.builtinModelIds = [];
  const paths = await fixture(t, {
    templateRules: [rule('account:template-only')],
    rules: [rule('account:valid'), rule('account:no-type', { type: 'zhipu-account', mode: 'individual-coding-plan' }), missingModels],
    credentials: Object.assign({}, ...['valid', 'template-only', 'no-type', 'no-models'].map(name => credential(`account:${name}`, `${name}@example.test`, `fake-key-${name}`))),
  });
  const snapshot = await accountSnapshot(paths, env);
  assert.deepEqual(Object.keys(snapshot.config.providers), ['account:valid']);
  assert.equal(snapshot.config.states['account:valid'].entitled, true);
  assert.equal(snapshot.config.states['account:valid'].current, true);
});

test('runtime auth selects only the requested provider key and rejects malformed or mismatched selection', async t => {
  const identity = 'shared+identity/한글@example.test';
  const paths = await fixture(t, { credentials: {
    ...credential('account:a', identity, 'key-for-a'),
    ...credential('account:b', identity, 'key-for-b'),
    ...credential('account:missing-key', identity),
  } });
  const params = providerId => ({ providerId, modelSelection: { providerId, modelId: 'GLM-5.3' }, accountAccess: { mode: 'individual-coding-plan' } });
  assert.deepEqual(await requestAuth(paths, params('account:a'), env), { headersApplied: true, requestAuth: { apiKey: 'key-for-a' } });
  assert.deepEqual(await requestAuth(paths, params('account:b'), env), { headersApplied: true, requestAuth: { apiKey: 'key-for-b' } });
  for (const invalid of [
    {}, { ...params('account:a'), providerId: null }, params('custom:a'),
    { ...params('account:a'), modelSelection: { providerId: 'account:b', modelId: 'GLM-5.3' } },
    { ...params('account:a'), modelSelection: undefined },
    { ...params('account:a'), accountAccess: { mode: 'shared' } },
    { ...params('account:a'), accountAccess: undefined },
  ]) await assert.rejects(requestAuth(paths, invalid, env), /Unsupported ZCode account authentication request/);
  await assert.rejects(requestAuth(paths, params('account:missing-key'), env), /ZCode login credentials unavailable/);
  await assert.rejects(requestAuth(paths, params('account:absent'), env), /ZCode login credentials unavailable/);
});

test('malformed credential files fail without exposing file content', async t => {
  const paths = await fixture(t);
  await writeFile(paths.credentials, '{"secret":"do-not-leak-this-test-secret",');
  await assert.rejects(accountSnapshot(paths, env), error => {
    assert.equal(error.message, 'Unable to read ZCode credentials.json');
    assert.doesNotMatch(error.message, /do-not-leak/);
    return true;
  });
});
