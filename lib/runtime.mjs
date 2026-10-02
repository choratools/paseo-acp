import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const userPath = value => value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(value);
export async function isFile(file) {
  try { return Boolean(file) && (await stat(file)).isFile(); } catch { return false; }
}
export async function executable(command, env = process.env) {
  if (!command || typeof command !== 'string') return null;
  const candidates = command.includes('/') || command.includes('\\') || path.isAbsolute(command)
    ? [userPath(command)] : (env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(directory => {
      const extensions = process.platform === 'win32' ? ['', ...((env.PATHEXT || '.EXE;.CMD;.BAT').split(';'))] : [''];
      return extensions.map(extension => path.join(directory, command + extension));
    });
  for (const file of candidates) {
    try {
      if (!await isFile(file)) continue;
      await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

export async function discoverZcode(env = process.env, required = true) {
  const resources = [];
  if (env.ZCODE_ACP_RESOURCES) {
    const root = userPath(env.ZCODE_ACP_RESOURCES);
    if (!await isFile(path.join(root, 'glm/zcode.cjs')) || !await isFile(path.join(root, 'config/provider/zcode-builtin.json'))) throw new Error('ZCODE_ACP_RESOURCES must point to a ZCode resources directory');
    resources.push(root);
  }
  if (env.ZCODE_ACP_DESKTOP_ASAR) {
    const file = userPath(env.ZCODE_ACP_DESKTOP_ASAR);
    if (!await isFile(file)) throw new Error('ZCODE_ACP_DESKTOP_ASAR must point to an existing app.asar file');
    resources.push(path.dirname(file));
  }
  const launcher = await executable('zcode', env);
  if (launcher) {
    try { resources.push(path.join(path.dirname(await realpath(launcher)), 'resources')); } catch {}
  }
  if (process.platform === 'darwin') {
    resources.push('/Applications/ZCode.app/Contents/Resources', path.join(os.homedir(), 'Applications/ZCode.app/Contents/Resources'));
  } else if (process.platform === 'win32') {
    if (env.ZCODE_WINDOWS_APP_INSTALL_DIR) resources.push(path.join(env.ZCODE_WINDOWS_APP_INSTALL_DIR, 'resources'));
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
      if (env[key]) resources.push(path.join(env[key], 'ZCode/resources'));
    }
    if (env.LOCALAPPDATA) resources.push(path.join(env.LOCALAPPDATA, 'Programs/ZCode/resources'));
  } else resources.push('/opt/ZCode/resources', '/usr/lib/zcode/resources', path.join(os.homedir(), '.local/share/ZCode/resources'));

  const overrideRuntime = env.ZCODE_ACP_RUNTIME ? userPath(env.ZCODE_ACP_RUNTIME) : null;
  if (overrideRuntime && !await isFile(overrideRuntime)) throw new Error('ZCODE_ACP_RUNTIME must point to an existing zcode.cjs file');
  let runtimePath = overrideRuntime;
  let resourceRoot = null;
  for (const root of [...new Set(resources)]) {
    const candidate = path.join(root, 'glm/zcode.cjs');
    if (await isFile(candidate) && (!runtimePath || runtimePath === candidate)) {
      runtimePath = candidate; resourceRoot = root; break;
    }
    if (overrideRuntime && await isFile(path.join(root, 'app.asar'))) resourceRoot ||= root;
  }
  const builtinCandidates = [
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && userPath(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE),
    overrideRuntime && path.join(path.dirname(runtimePath), 'provider/zcode-builtin.json'),
    overrideRuntime && path.join(path.dirname(runtimePath), '../config/provider/zcode-builtin.json'),
    resourceRoot && path.join(resourceRoot, 'config/provider/zcode-builtin.json'),
    runtimePath && path.join(path.dirname(runtimePath), 'provider/zcode-builtin.json'),
  ].filter(Boolean);
  let builtinPath = null;
  for (const file of builtinCandidates) if (await isFile(file)) { builtinPath = file; break; }
  if (env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && !await isFile(userPath(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE))) {
    throw new Error('ZCODE_BUILTIN_PROVIDER_CONFIG_FILE must point to an existing provider JSON file');
  }
  const asarCandidates = [env.ZCODE_ACP_DESKTOP_ASAR && userPath(env.ZCODE_ACP_DESKTOP_ASAR), resourceRoot && path.join(resourceRoot, 'app.asar')].filter(Boolean);
  let desktopAsar = null;
  for (const file of asarCandidates) if (await isFile(file)) { desktopAsar = file; break; }
  if (required && (!runtimePath || !builtinPath)) throw new Error('ZCode runtime not found. Install ZCode, or set ZCODE_ACP_RUNTIME and ZCODE_BUILTIN_PROVIDER_CONFIG_FILE. Run paseo-acp doctor for details.');
  return { runtimePath, builtinPath, desktopAsar, resourceRoot, available: Boolean(runtimePath && builtinPath) };
}
