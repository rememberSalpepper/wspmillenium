const { app, config, database } = require('./src/app');
const { log } = require('./src/logger');

const server = app.listen(config.PORT, () => {
  log('info', 'server.started', {
    port: config.PORT,
    webhookPath: '/webhook',
    healthPath: '/health',
  });
});

function shutdown(signal) {
  log('info', 'server.shutdown_start', { signal });

  server.close(() => {
    database.close();
    log('info', 'server.shutdown_complete', { signal });
    process.exit(0);
  });

  setTimeout(() => {
    log('error', 'server.shutdown_forced', { signal });
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));