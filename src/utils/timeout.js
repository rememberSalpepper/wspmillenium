function withTimeout(promise, ms, label = 'Timeout') {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(label);
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

module.exports = { withTimeout };