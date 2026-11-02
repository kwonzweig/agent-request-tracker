import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isJournalId } from './identity.mjs';

function invalid(code, message) {
  return Object.assign(new TypeError(message), { code });
}

function trackingPath(dataDir, conversationId) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0')) {
    throw new TypeError('dataDir must be a nonblank directory path without null bytes');
  }
  if (!isJournalId(conversationId)) {
    throw invalid('INVALID_ID', 'conversation id must be a safe journal identifier');
  }
  return path.join(dataDir, 'tracking', `${conversationId}.json`);
}

export async function isTrackingEnabled(dataDir, conversationId) {
  const file = trackingPath(dataDir, conversationId);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      await fs.access(path.join(dataDir, `${conversationId}.json`));
      return true;
    } catch (legacyError) {
      if (legacyError.code === 'ENOENT') return false;
      throw legacyError;
    }
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw invalid('INVALID_TRACKING_CONFIG', `tracking setting for ${conversationId} must be valid JSON`);
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config) || typeof config.enabled !== 'boolean') {
    throw invalid('INVALID_TRACKING_CONFIG', `tracking setting for ${conversationId} needs a boolean enabled value`);
  }
  return config.enabled;
}

export async function setTrackingEnabled(dataDir, conversationId, enabled) {
  const file = trackingPath(dataDir, conversationId);
  if (typeof enabled !== 'boolean') {
    throw invalid('INVALID_TRACKING_ENABLED', 'enabled must be a boolean');
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ enabled })}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    return enabled;
  } catch (error) {
    try { await fs.rm(temporary, { force: true }); }
    catch (cleanupError) { error.cleanup_error = cleanupError; }
    throw error;
  }
}
