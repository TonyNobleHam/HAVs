import { DatabaseSync } from 'node:sqlite';
import { constants, copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const usage = `Restore a complete HAVS SQLite backup after stopping the API server.
  node scripts/restore.mjs --source BACKUP.sqlite --confirm-offline
  node scripts/restore.mjs --stdin --confirm-offline < BACKUP.sqlite

HAVS_DATA_DIR selects the destination directory (default: ./data).
--confirm-offline acknowledges that ALL processes using that database are stopped.
The script cannot detect every running server. Never restore a live database.
The previous database is preserved and restored login sessions are revoked.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const stdin = args.includes('--stdin');
  const sourceAt = args.indexOf('--source');
  const expected = stdin ? 2 : 3;
  if (!args.includes('--confirm-offline') || args.length !== expected ||
      (stdin ? sourceAt !== -1 : sourceAt === -1 || !args[sourceAt + 1] || args[sourceAt + 1].startsWith('--')) ||
      args.some((arg, index) => index !== sourceAt + 1 && !['--confirm-offline', '--source', '--stdin'].includes(arg))) {
    throw new Error(usage);
  }

  const directory = resolve(process.env.HAVS_DATA_DIR ?? 'data');
  const destination = join(directory, 'havs.sqlite');
  const source = stdin ? null : resolve(args[sourceAt + 1]);
  if (source === destination) throw new Error('The backup source must differ from the destination database.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const suffix = `${Date.now()}-${randomUUID()}`;
  const staged = join(directory, `.restore-${suffix}.sqlite`);
  const previous = join(directory, `before-restore-${suffix}`);
  const moved = [];
  let installed = false;

  try {
    if (stdin) await pipeline(process.stdin, createWriteStream(staged, { flags: 'wx', mode: 0o600 }));
    else { copyFileSync(source, staged, constants.COPYFILE_EXCL); chmodSync(staged, 0o600); }
    const db = new DatabaseSync(staged);
    try {
      const integrity = db.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
      // Verify the application schema before touching the existing database.
      for (const query of [
        'SELECT id,email,name,password_hash,created_at FROM users LIMIT 0',
        'SELECT token_hash,user_id,expires_at FROM sessions LIMIT 0',
        'SELECT code_hash,email,expires_at,used_at FROM invites LIMIT 0',
        'SELECT user_id,document,revision,updated_at FROM workspaces LIMIT 0',
        'SELECT key_hash,attempts,started_at FROM rate_limits LIMIT 0',
      ]) db.prepare(query).all();
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup foreign key check failed.');
      db.exec('PRAGMA journal_mode = DELETE; DELETE FROM sessions;');
    } finally { db.close(); }

    // Keep the complete old database set so rollback does not lose WAL contents.
    for (const extension of ['', '-wal', '-shm']) {
      if (existsSync(destination + extension)) {
        if (!existsSync(previous)) mkdirSync(previous, { mode: 0o700 });
        const saved = join(previous, 'havs.sqlite' + extension);
        renameSync(destination + extension, saved);
        moved.push([destination + extension, saved]);
      }
    }
    renameSync(staged, destination);
    installed = true;
    console.log('Backup restored. All users must log in again.');
    if (moved.length) console.log(`Previous database preserved at: ${previous}`);
  } catch (error) {
    if (!installed) {
      for (const [original, saved] of moved.reverse()) renameSync(saved, original);
    }
    throw error;
  } finally {
    for (const extension of ['', '-wal', '-shm', '-journal']) {
      if (existsSync(staged + extension)) unlinkSync(staged + extension);
    }
  }
}

main().catch((error) => {
  console.error(error.code?.startsWith('SQLITE') ? 'Invalid or incompatible HAVS database backup.' : error.message);
  process.exitCode = 1;
});
