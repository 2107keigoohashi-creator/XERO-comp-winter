/** テンプレート本文の {変数名} を置換する。未定義の変数はそのまま残す。 */
export function renderTemplate(body: string, vars: Record<string, string | number | null | undefined>): string {
  return body.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, key: string) => {
    const v = vars[key];
    return v == null ? whole : String(v);
  });
}

export function templateVariables(body: string): string[] {
  return [...new Set([...body.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]))];
}
