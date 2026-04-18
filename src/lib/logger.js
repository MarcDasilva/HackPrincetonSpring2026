const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(scope = "app", level = process.env.LOG_LEVEL || "info") {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(levelName, message, fields = {}) {
    if ((LEVELS[levelName] ?? LEVELS.info) < threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level: levelName,
      scope,
      message,
      ...fields,
    };
    const stream = levelName === "error" ? console.error : console.log;
    stream(JSON.stringify(line));
  }

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (childScope) => createLogger(`${scope}:${childScope}`, level),
  };
}

export async function withRetry(fn, options = {}) {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 250;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
    }
  }

  throw lastError;
}
