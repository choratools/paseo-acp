// Metadata for empty sessions, which native ZCode does not persist until use.
// No prompts, tool inputs, credentials or MCP headers are stored here.
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export class SessionMetadata {
  constructor(directory) { this.directory = directory; }
  file(id) { return path.join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`); }
  async read(id) {
    if (typeof id !== 'string') return null;
    try {
      const value = JSON.parse(await readFile(this.file(id), 'utf8'));
      if (value.version !== 1 || value.id !== id || typeof value.nativeId !== 'string' ||
          typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || typeof value.everPrompted !== 'boolean') {
        throw new Error('Invalid ACP session metadata');
      }
      return value;
    } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Unable to read ACP session metadata'); }
  }
  async write(session) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const record = { version: 1, id: session.id, nativeId: session.nativeId, cwd: session.cwd,
      mode: session.mode, model: session.model, thoughtLevel: session.thoughtLevel, everPrompted: session.everPrompted,
      createdAt: session.createdAt, updatedAt: new Date().toISOString() };
    const target = this.file(session.id), temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => {}); }
    return record;
  }
  async list(cwd) {
    let files;
    try { files = await readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const file of files.filter(file => /^[0-9a-f]{64}\.json$/.test(file))) {
      const record = JSON.parse(await readFile(path.join(this.directory, file), 'utf8'));
      const verified = await this.read(record.id);
      if (verified && (!cwd || verified.cwd === cwd)) records.push(verified);
    }
    return records;
  }
}
