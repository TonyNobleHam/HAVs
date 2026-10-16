import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let stopping = false;
let failure = 0;
let killTimer;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  failure = code;
  for (const child of children) child.kill('SIGTERM');
  killTimer = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 5000);
  killTimer.unref();
}

function start(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  children.push(child);
  child.once('error', (error) => {
    console.error(`${label}: ${error.message}`);
    stop(1);
  });
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`${label} stopped (${signal ?? code}). Stopping the other service.`);
      stop(code || 1);
    }
    if (children.every((item) => item.exitCode !== null || item.signalCode !== null)) {
      clearTimeout(killTimer);
      process.exitCode = failure;
    }
  });
  return child;
}

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));

start('HAVS API', ['--experimental-strip-types', 'server/index.mjs'], {
  NODE_ENV: 'development',
});
start('Vite', ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0', '--port', '5173', '--strictPort'], {
  NODE_ENV: 'development',
  VITE_API_TARGET: process.env.VITE_API_TARGET ?? `http://127.0.0.1:${process.env.PORT ?? '3001'}`,
});
