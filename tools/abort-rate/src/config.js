const fs = require('node:fs');
const path = require('node:path');

function getByDottedPath(object, dottedPath) {
  const parts = dottedPath.split('.');
  let current = object;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function setByDottedPath(object, dottedPath, value) {
  const parts = dottedPath.split('.');
  let current = object;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] == null || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function loadJson(filePath) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  return JSON.parse(raw);
}

function validateConfig(config) {
  const required = [
    'outputDir',
    'system',
    'fabric.peerEndpoint',
    'fabric.tlsCertPath',
    'fabric.mspId',
    'fabric.certPath',
    'fabric.keyPath',
    'fabric.channelName',
    'fabric.chaincodeName',
    'workload.name',
    'scenario.name',
    'driver.mode',
    'driver.totalRequests',
    'driver.concurrency',
    'driver.maxAttemptsPerRequest'
  ];

  const missing = required.filter((key) => getByDottedPath(config, key) === undefined);
  if (missing.length > 0) {
    const message = `Missing required config fields: ${missing.join(', ')}`;
    const error = new Error(message);
    error.missing = missing;
    throw error;
  }

  const maxAttempts = Number(config.driver?.maxAttemptsPerRequest);
  if (!Number.isFinite(maxAttempts)) {
    throw new Error('driver.maxAttemptsPerRequest must be a number (use 0 for unlimited retries)');
  }
  if (maxAttempts === 0) {
    // 0 means unlimited retries (until requestTimeoutMs, if set).
  } else if (maxAttempts < 0) {
    throw new Error('driver.maxAttemptsPerRequest must be >= 0 (0 means unlimited retries)');
  }

  if (config.driver?.window) {
    const w = config.driver.window;
    if (w.type !== 'count' && w.type !== 'time') {
      throw new Error(`driver.window.type must be "count" or "time" (got: ${String(w.type)})`);
    }
    if (w.type === 'count') {
      const size = Number(w.size ?? 0);
      if (!Number.isFinite(size) || size <= 0) throw new Error('driver.window.size must be a positive number');
    }
    if (w.type === 'time') {
      const ms = Number(w.ms ?? 0);
      if (!Number.isFinite(ms) || ms <= 0) throw new Error('driver.window.ms must be a positive number');
    }
  }

  if (config.driver?.windowMerge) {
    const wm = config.driver.windowMerge;
    const t = String(wm.type ?? '');
    if (!['key_merge', 'key_then_value', 'value_merge', 'value_then_key', 'ctm'].includes(t)) {
      throw new Error('driver.windowMerge.type must be "key_merge", "key_then_value", "value_merge", "value_then_key", or "ctm"');
    }
    if (!config.driver?.window) {
      throw new Error('driver.windowMerge requires driver.window');
    }
    if (config.driver.window.type !== 'count') {
      throw new Error('driver.windowMerge currently supports only driver.window.type="count"');
    }
  }
}

module.exports = {
  loadJson,
  validateConfig,
  getByDottedPath,
  setByDottedPath
};
