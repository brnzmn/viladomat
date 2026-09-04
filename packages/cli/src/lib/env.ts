import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (packages/cli/src/lib -> ../../../..). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

let loaded = false;

/** Load `.env` from the repository root once (Node's built-in loader; never commits secrets). */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = path.join(REPO_ROOT, '.env');
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      /* ignore parse errors: the caller will fail on the missing variable */
    }
  }
}

export function env(name: string, fallback?: string): string {
  loadEnv();
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing environment variable ${name} (see .env.example)`);
  }
  return v;
}

export function envOptional(name: string): string | undefined {
  loadEnv();
  const v = process.env[name];
  return v === '' ? undefined : v;
}

export const PIPELINE_VERSION = (): string => envOptional('PIPELINE_VERSION') ?? '1';
