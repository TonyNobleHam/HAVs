import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openStore, validPassword } from './store.mjs';

const usage = `Usage:
  node server/manage.mjs create-user --email EMAIL --name NAME [--password-stdin]
  node server/manage.mjs reset-password --email EMAIL [--password-stdin]
  node server/manage.mjs create-invite [--email EMAIL]
  node server/manage.mjs backup --output PATH

Passwords are read from a hidden terminal prompt, or from standard input when
--password-stdin is explicitly selected. Never put passwords in command arguments.
HAVS_DATA_DIR selects the persistent data directory (default: ./data).
Invitations expire in seven days and can be used once. Backups contain private data.`;

async function readPassword(stdin) {
  if (stdin) {
    let text = '';
    for await (const chunk of process.stdin) {
      text += chunk;
      if (Buffer.byteLength(text) > 1024) throw new Error('Password input is too long.');
    }
    return text.replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Use an interactive terminal or explicitly pass --password-stdin.');
  process.stderr.write('Password (12–128 characters, hidden): ');
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    const finish = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', handle);
      process.stderr.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const handle = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003' || character === '\u0004') return finish(new Error('Cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = [...value].slice(0, -1).join('');
        else if (character >= ' ' && value.length < 129) value += character;
      }
    };
    process.stdin.on('data', handle);
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') { console.log(usage); return; }
  const permitted = {
    'create-user': ['email', 'name', 'password-stdin'],
    'reset-password': ['email', 'password-stdin'],
    'create-invite': ['email'],
    backup: ['output'],
  }[command];
  if (!permitted) throw new Error('Unknown command. Run with --help.');
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--') || !permitted.includes(arg.slice(2)) || Object.hasOwn(flags, arg.slice(2))) throw new Error('Invalid or duplicate argument. Run with --help.');
    const key = arg.slice(2);
    if (key === 'password-stdin') flags[key] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for --${key}.`);
      flags[key] = args[++index];
    }
  }
  const store = openStore(process.env.HAVS_DATA_DIR ?? resolve('data'));
  try {
    if (command === 'create-user' || command === 'reset-password') {
      if (!flags.email || (command === 'create-user' && !flags.name)) throw new Error('Required account details are missing. Run with --help.');
      const password = await readPassword(flags['password-stdin']);
      if (!validPassword(password)) throw new Error('Password must contain 12–128 characters.');
      if (command === 'create-user') { await store.createUser({ email: flags.email, name: flags.name, password }); console.log('Account created.'); }
      else { await store.resetPassword(flags.email, password); console.log('Password reset; existing sessions revoked.'); }
    } else if (command === 'create-invite') {
      const invitation = store.createInvite({ email: flags.email ?? null });
      console.log(`Invitation code: ${invitation.code}\nExpires at: ${new Date(invitation.expiresAt).toISOString()}`);
    } else {
      if (!flags.output) throw new Error('--output is required.');
      if (existsSync(resolve(flags.output))) throw new Error('Backup destination already exists; use a new path.');
      await store.backup(flags.output);
      console.log('Database backup completed. Store the backup securely.');
    }
  } finally { store.close(); }
}

main().catch((error) => { console.error(error.code?.startsWith('SQLITE') ? 'Database operation failed. Check the data directory and account details.' : error.message); process.exitCode = 1; });
