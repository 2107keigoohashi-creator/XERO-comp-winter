import path from 'node:path';
import { env } from '../config';
import { SqliteRepository } from './sqlite';
import type { Repository } from './types';

let repo: Repository | null = null;

/** DB 実装の差し替えポイント（Supabase 移行時はここで SupabaseRepository を返す） */
export function getRepository(): Repository {
  if (!repo) repo = new SqliteRepository(path.join(env.dataDir, 'tournament.db'));
  return repo;
}

export function setRepository(r: Repository): void {
  repo = r;
}

export * from './types';
