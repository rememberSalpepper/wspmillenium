function log(level, event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };

  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
    return;
  }

  console.log(line);
}

module.exports = { log };