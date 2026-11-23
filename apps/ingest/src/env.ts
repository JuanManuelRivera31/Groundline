import { existsSync } from 'node:fs';
import { parseConfig, type AppConfig } from '@groundline/core';
import { ENV_FILE } from './paths.ts';

/** Loads .env (if present) into process.env and parses the app config. */
export function loadConfig(): AppConfig {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  return parseConfig(process.env);
}

/** Connection string with the password masked, safe to print. */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<unparseable DATABASE_URL>';
  }
}
