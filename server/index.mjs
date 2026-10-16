import { createApp } from './app.mjs';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const app = createApp({ onError: () => console.error('An unexpected request error occurred.') });
app.server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`HAVS server listening on port ${port}.`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { app.close().then(() => process.exit(0)).catch(() => process.exit(1)); });
}
