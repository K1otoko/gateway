import { buildApp } from './app.js';

async function start(): Promise<void> {
  const app = await buildApp();
  let closing = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (closing) {
      return;
    }

    closing = true;
    app.log.info({ signal }, 'shutting down gateway');

    try {
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, 'gateway shutdown failed');
      process.exitCode = 1;
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen({
    host: app.config.HOST,
    port: app.config.PORT,
  });

  app.log.info(
    {
      host: app.config.HOST,
      port: app.config.PORT,
    },
    'gateway listening',
  );
}

start().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
