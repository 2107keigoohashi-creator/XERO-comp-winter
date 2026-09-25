import fs from 'node:fs';
import path from 'node:path';
import { env } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(env.logLevel as Level) in ORDER ? (env.logLevel as Level) : 'info'];

fs.mkdirSync(env.logDir, { recursive: true });
const logFile = path.join(env.logDir, 'bot.log');

/** トークン等の秘密情報をログに出さないためのマスク処理 */
const secrets = [env.token].filter((s) => s.length > 8);
function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  // Discord トークン形式・Webhook URL を念のためマスク
  out = out.replace(/[MNO][\w-]{23,25}\.[\w-]{6}\.[\w-]{27,40}/g, '[REDACTED_TOKEN]');
  out = out.replace(/(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[\w-]+/g, '$1[REDACTED]');
  return out;
}

function format(value: unknown): string {
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: Level, scope: string, args: unknown[]): void {
  if (ORDER[level] < threshold) return;
  const line = redact(`${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${args.map(format).join(' ')}`);
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(line);
  fs.appendFile(logFile, line + '\n', () => undefined);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}
