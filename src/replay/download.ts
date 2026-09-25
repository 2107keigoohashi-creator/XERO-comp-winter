import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

export class DownloadError extends Error {}

/** Google Drive の共有リンクを直接ダウンロード用 URL に変換する */
export function toDirectUrl(url: string): string {
  const drive = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/) ?? url.match(/drive\.google\.com\/open\?id=([\w-]+)/);
  if (drive) return `https://drive.usercontent.google.com/download?id=${drive[1]}&export=download&confirm=t`;
  if (/^https:\/\/(www\.)?dropbox\.com\//.test(url)) {
    const u = new URL(url);
    u.searchParams.set('dl', '1');
    return u.toString();
  }
  return url;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** URL からファイルをダウンロードして保存する。サイズ上限を超えたら中断する。 */
export async function downloadFile(url: string, dest: string, maxBytes: number): Promise<{ size: number }> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new DownloadError('unsupported protocol');

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new DownloadError(`HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    throw new DownloadError('HTML page returned (link is not a direct download link or file is not public)');
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new DownloadError(`file too large (${declared} bytes)`);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let size = 0;
  const body = Readable.fromWeb(res.body as unknown as WebReadableStream);
  body.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBytes) body.destroy(new DownloadError(`file too large (> ${maxBytes} bytes)`));
  });
  try {
    await pipeline(body, fs.createWriteStream(dest));
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
  return { size };
}
