export const createBackgroundTaskTracker = ({ onError = console.error } = {}) => {
  const tasks = new Set();

  const waitUntil = (promise) => {
    let tracked;
    tracked = Promise.resolve(promise)
      .catch((error) => {
        onError(error);
      })
      .finally(() => tasks.delete(tracked));
    tasks.add(tracked);
    return tracked;
  };

  const drain = async (timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (tasks.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      let timeout;
      const settled = await Promise.race([
        Promise.allSettled([...tasks]).then(() => true),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), remainingMs);
        }),
      ]);
      clearTimeout(timeout);
      if (!settled) return false;
    }
    return true;
  };

  return {
    waitUntil,
    drain,
    get size() {
      return tasks.size;
    },
  };
};

export const createExclusiveTaskRunner = (task, waitUntil = () => {}) => {
  let active = null;
  return () => {
    if (active) return active;
    active = Promise.resolve()
      .then(task)
      .finally(() => {
        active = null;
      });
    waitUntil(active);
    return active;
  };
};
