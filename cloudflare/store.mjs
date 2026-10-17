import { randomBytes, randomUUID } from 'node:crypto';
import {
  csrfFor, digest, hashPassword, normalizeEmail, validEmail, validName, validPassword,
} from '../server/credentials.mjs';
import { MAX_SYNC_WORKSPACE_BYTES } from '../src/limits.ts';

export const MAX_DOCUMENT_BYTES = MAX_SYNC_WORKSPACE_BYTES;
const textEncoder = new TextEncoder();

/** D1 migrations must be applied before using this adapter. It performs no setup on import. */
export function createD1Store(db, { now = Date.now } = {}) {
  const publicUser = (row) => row ? { id: row.id, email: row.email, name: row.name } : null;
  const findUser = (email) => db.prepare('SELECT * FROM users WHERE email = ?').bind(normalizeEmail(email)).first();
  const validInvite = async (code, email) => {
    if (typeof code !== 'string' || code.length > 100) return false;
    const invite = await db.prepare(`SELECT 1 AS valid FROM invites
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? AND (email IS NULL OR email = ?)`)
      .bind(digest(code), now(), normalizeEmail(email)).first();
    return !!invite;
  };

  return {
    db, publicUser, findUser, validInvite,
    async createUser({ email, name, password }) {
      email = normalizeEmail(email);
      if (!validEmail(email) || !validName(name)) throw new Error('A valid email and name are required.');
      if (await findUser(email)) throw new Error('An account with this email already exists.');
      const passwordHash = await hashPassword(password);
      const user = await db.prepare(`INSERT INTO users (id, email, name, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING RETURNING id, email, name`)
        .bind(randomUUID(), email, name.trim(), passwordHash, now()).first();
      if (!user) throw new Error('An account with this email already exists.');
      return publicUser(user);
    },
    async createInvite({ email = null, ttlMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
      if (email !== null) {
        email = normalizeEmail(email);
        if (!validEmail(email)) throw new Error('Invalid invitation email.');
      }
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('Invitation lifetime must be positive.');
      const code = randomBytes(24).toString('base64url');
      const timestamp = now();
      const expiresAt = timestamp + ttlMs;
      await db.batch([
        db.prepare(`DELETE FROM invites WHERE code_hash IN
          (SELECT code_hash FROM invites WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`).bind(timestamp),
        db.prepare('INSERT INTO invites (code_hash, email, expires_at, used_at) VALUES (?, ?, ?, NULL)')
          .bind(digest(code), email, expiresAt),
      ]);
      return { code, expiresAt };
    },
    async register({ email, name, password, inviteCode }) {
      email = normalizeEmail(email);
      if (!validEmail(email) || !validName(name) || !validPassword(password)) return null;
      if (!(await validInvite(inviteCode, email)) || await findUser(email)) return null;
      const passwordHash = await hashPassword(password);
      const id = randomUUID();
      const timestamp = now();
      const codeHash = digest(inviteCode);
      // D1 batch is one transaction. Only the request whose INSERT creates this
      // new UUID can consume the invitation; concurrent contenders insert no row.
      const result = await db.batch([
        db.prepare(`INSERT INTO users (id, email, name, password_hash, created_at)
          SELECT ?, ?, ?, ?, ? FROM invites
          WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
          AND (email IS NULL OR email = ?)
          AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?)
          RETURNING id, email, name`)
          .bind(id, email, name.trim(), passwordHash, timestamp, codeHash, timestamp, email, email),
        db.prepare(`UPDATE invites SET used_at = ? WHERE code_hash = ?
          AND EXISTS (SELECT 1 FROM users WHERE id = ?)`)
          .bind(timestamp, codeHash, id),
      ]);
      const user = publicUser(result[0].results[0] ?? null);
      // Keep the hash used for this registration as a private receipt. The API
      // must bind session creation to it and return only the public user fields.
      return user ? { user, verifiedPasswordHash: passwordHash } : null;
    },
    async createSession(userId, ttlMs, verifiedPasswordHash = null) {
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('Session lifetime must be positive.');
      const token = randomBytes(32).toString('base64url');
      const timestamp = now();
      const result = await db.batch([
        db.prepare(`DELETE FROM sessions WHERE token_hash IN
          (SELECT token_hash FROM sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`).bind(timestamp),
        db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at)
          SELECT ?, id, ? FROM users WHERE id = ? AND (? IS NULL OR password_hash = ?)
          RETURNING token_hash`)
          .bind(digest(token), timestamp + ttlMs, userId, verifiedPasswordHash, verifiedPasswordHash),
      ]);
      return result[1].results.length ? { token, csrfToken: csrfFor(token) } : null;
    },
    async session(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const row = await db.prepare(`SELECT u.id, u.email, u.name FROM sessions s
        JOIN users u ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ?`)
        .bind(digest(token), now()).first();
      return row ? { user: publicUser(row), csrfToken: csrfFor(token) } : null;
    },
    async revokeSession(token) {
      await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(digest(token)).run();
    },
    async resetPassword(email, password) {
      email = normalizeEmail(email);
      if (!(await findUser(email))) throw new Error('Account not found.');
      const passwordHash = await hashPassword(password);
      // The migration's trigger revokes all sessions within this same UPDATE.
      const row = await db.prepare('UPDATE users SET password_hash = ? WHERE email = ? RETURNING id')
        .bind(passwordHash, email).first();
      if (!row) throw new Error('Account not found.');
    },
    async workspace(userId) {
      const row = await db.prepare('SELECT document, revision FROM workspaces WHERE user_id = ?').bind(userId).first();
      return row ? { workspace: JSON.parse(row.document), revision: row.revision } : { workspace: null, revision: 0 };
    },
    async saveWorkspace(userId, workspace, revision) {
      if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid workspace revision.');
      const document = JSON.stringify(workspace);
      if (textEncoder.encode(document).byteLength > MAX_DOCUMENT_BYTES) {
        throw Object.assign(new Error('작업 공간이 너무 큽니다. 최대 1.9 MB입니다.'), { status: 413, code: 'WORKSPACE_TOO_LARGE' });
      }
      const row = await db.prepare(`INSERT INTO workspaces (user_id, document, revision, updated_at)
        SELECT ?, ?, ?, ? WHERE ? = 0 OR EXISTS
          (SELECT 1 FROM workspaces WHERE user_id = ? AND revision = ?)
        ON CONFLICT(user_id) DO UPDATE SET document = excluded.document,
          revision = excluded.revision, updated_at = excluded.updated_at
        WHERE workspaces.revision = ?
        RETURNING revision`)
        .bind(userId, document, revision + 1, now(), revision, userId, revision, revision).first();
      return row?.revision ?? null;
    },
    async consumeRateLimit(key, limit, windowMs) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error('Invalid rate limit configuration.');
      const keyHash = digest(key);
      const timestamp = now();
      const cutoff = timestamp - windowMs;
      const result = await db.batch([
        db.prepare(`DELETE FROM rate_limits WHERE key_hash IN
          (SELECT key_hash FROM rate_limits WHERE started_at <= ? ORDER BY started_at LIMIT 100)`).bind(cutoff),
        db.prepare(`INSERT INTO rate_limits (key_hash, attempts, started_at) VALUES (?, 1, ?)
          ON CONFLICT(key_hash) DO UPDATE SET
            attempts = CASE WHEN started_at <= ? THEN 1 ELSE attempts + 1 END,
            started_at = CASE WHEN started_at <= ? THEN excluded.started_at ELSE started_at END
          WHERE started_at <= ? OR attempts < ?
          RETURNING attempts, started_at`)
          .bind(keyHash, timestamp, cutoff, cutoff, cutoff, limit),
        db.prepare('SELECT started_at FROM rate_limits WHERE key_hash = ?').bind(keyHash),
      ]);
      if (result[1].results.length) return 0;
      const startedAt = result[2].results[0]?.started_at ?? timestamp;
      return Math.max(1, Math.ceil((startedAt + windowMs - timestamp) / 1000));
    },
  };
}
