import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { digest, csrfFor, normalizeEmail, validEmail, validPassword, validName, hashPassword, verifyPassword } from './credentials.mjs';
export { digest, csrfFor, normalizeEmail, validEmail, validPassword, validName, hashPassword, verifyPassword } from './credentials.mjs';

export function openStore(dataDir, { now = Date.now } = {}) {
  const directory = resolve(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databasePath = join(directory, 'havs.sqlite');
  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS invites (
      code_hash TEXT PRIMARY KEY, email TEXT, expires_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      document TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rate_limits (
      key_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, started_at INTEGER NOT NULL
    );
  `);
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const publicUser = (row) => row ? { id: row.id, email: row.email, name: row.name } : null;
  const findUser = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));
  const insertUser = (email, name, passwordHash) => {
    const user = { id: randomUUID(), email: normalizeEmail(email), name: name.trim() };
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(user.id, user.email, user.name, passwordHash, now());
    return user;
  };
  return {
    db, databasePath, findUser, publicUser,
    async createUser({ email, name, password }) {
      email = normalizeEmail(email);
      if (!validEmail(email) || !validName(name)) throw new Error('A valid email and name are required.');
      if (findUser(email)) throw new Error('An account with this email already exists.');
      return insertUser(email, name, await hashPassword(password));
    },
    createInvite({ email = null, ttlMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
      if (email !== null) {
        email = normalizeEmail(email);
        if (!validEmail(email)) throw new Error('Invalid invitation email.');
      }
      const code = randomBytes(24).toString('base64url');
      const expiresAt = now() + ttlMs;
      db.prepare('INSERT INTO invites VALUES (?, ?, ?, NULL)').run(digest(code), email, expiresAt);
      return { code, expiresAt };
    },
    validInvite(code, email) {
      if (typeof code !== 'string' || code.length > 100) return false;
      const invite = db.prepare('SELECT * FROM invites WHERE code_hash = ?').get(digest(code));
      return !!invite && !invite.used_at && invite.expires_at > now() && (!invite.email || invite.email === normalizeEmail(email));
    },
    async register({ email, name, password, inviteCode }) {
      email = normalizeEmail(email);
      if (!validEmail(email) || !validName(name) || !validPassword(password)) return null;
      if (!this.validInvite(inviteCode, email) || findUser(email)) return null;
      const passwordHash = await hashPassword(password);
      return transaction(() => {
        if (!this.validInvite(inviteCode, email) || findUser(email)) return null;
        const user = insertUser(email, name, passwordHash);
        db.prepare('UPDATE invites SET used_at = ? WHERE code_hash = ?').run(now(), digest(inviteCode));
        return { user, verifiedPasswordHash: passwordHash };
      });
    },
    createSession(userId, ttlMs, verifiedPasswordHash = null) {
      return transaction(() => {
        // A password reset may complete while asynchronous scrypt is checking the old password.
        // Do not let that in-flight login recreate a session after all sessions were revoked.
        if (verifiedPasswordHash !== null && db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId)?.password_hash !== verifiedPasswordHash) return null;
        db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
        const token = randomBytes(32).toString('base64url');
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), userId, now() + ttlMs);
        return { token, csrfToken: csrfFor(token) };
      });
    },
    session(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const row = db.prepare(`SELECT u.id, u.email, u.name FROM sessions s
        JOIN users u ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ?`).get(digest(token), now());
      return row ? { user: publicUser(row), csrfToken: csrfFor(token) } : null;
    },
    revokeSession(token) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token)); },
    async resetPassword(email, password) {
      const user = findUser(email);
      if (!user) throw new Error('Account not found.');
      const passwordHash = await hashPassword(password);
      transaction(() => {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      });
    },
    workspace(userId) {
      const row = db.prepare('SELECT document, revision FROM workspaces WHERE user_id = ?').get(userId);
      return row ? { workspace: JSON.parse(row.document), revision: row.revision } : { workspace: null, revision: 0 };
    },
    saveWorkspace(userId, workspace, revision) {
      return transaction(() => {
        const current = db.prepare('SELECT revision FROM workspaces WHERE user_id = ?').get(userId);
        if ((current?.revision ?? 0) !== revision) return null;
        const next = revision + 1;
        db.prepare(`INSERT INTO workspaces VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET document = excluded.document,
          revision = excluded.revision, updated_at = excluded.updated_at`).run(userId, JSON.stringify(workspace), next, now());
        return next;
      });
    },
    consumeRateLimit(key, limit, windowMs) {
      return transaction(() => {
        const hash = digest(key);
        db.prepare('DELETE FROM rate_limits WHERE started_at <= ?').run(now() - windowMs);
        const row = db.prepare('SELECT * FROM rate_limits WHERE key_hash = ?').get(hash);
        if (row && row.attempts >= limit) return Math.max(1, Math.ceil((row.started_at + windowMs - now()) / 1000));
        db.prepare(`INSERT INTO rate_limits VALUES (?, 1, ?)
          ON CONFLICT(key_hash) DO UPDATE SET attempts = attempts + 1`).run(hash, now());
        return 0;
      });
    },
    async backup(destination) {
      const target = resolve(destination);
      if (target === databasePath) throw new Error('Backup destination must differ from the database.');
      closeSync(openSync(target, 'wx', 0o600));
      try { await backup(db, target); }
      catch (error) { unlinkSync(target); throw error; }
      return target;
    },
    close() { db.close(); },
  };
}
