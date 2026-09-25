import { getTournament } from '../config';
import { en } from './en';
import { ja, type MessageKey } from './ja';

export type { MessageKey };

const locales: Record<string, Partial<Record<MessageKey, string>>> = { ja, en };

/** メッセージを取得する。言語は config/tournament.json の language で切替。未翻訳のキーは日本語にフォールバック。 */
export function t(key: MessageKey, params: Record<string, string | number | null | undefined> = {}, lang?: string): string {
  const language = lang ?? getTournament().language;
  const template = locales[language]?.[key] ?? ja[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v == null ? whole : String(v);
  });
}
