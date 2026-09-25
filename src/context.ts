import type { Client } from 'discord.js';
import { env } from './config';
import { getRepository, type Repository } from './db';
import { createParser, type ReplayParser } from './replay/parser';
import { JobQueue } from './replay/queue';

/** Bot 全体で共有する依存関係 */
export interface AppContext {
  client: Client;
  repo: Repository;
  parser: ReplayParser;
  queue: JobQueue;
}

let ctx: AppContext | null = null;

export function initContext(client: Client): AppContext {
  ctx = { client, repo: getRepository(), parser: createParser(), queue: new JobQueue(env.replayConcurrency) };
  return ctx;
}

export function getContext(): AppContext {
  if (!ctx) throw new Error('context is not initialized');
  return ctx;
}
