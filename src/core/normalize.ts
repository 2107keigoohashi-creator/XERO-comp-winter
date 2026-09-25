/** 表示名の揺れ（全角/半角・大文字小文字・前後空白）を吸収して比較用のキーにする */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalizeEpicId(id: string | null | undefined): string | null {
  if (!id) return null;
  const v = id.trim().toLowerCase();
  return v.length ? v : null;
}

/** プレイヤーを一意に識別するキー（Epic ID 優先、なければ表示名） */
export function playerKey(p: { epicId: string | null; name: string }): string {
  const id = normalizeEpicId(p.epicId);
  return id ? `id:${id}` : `name:${normalizeName(p.name)}`;
}
