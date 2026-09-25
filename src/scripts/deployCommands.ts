/**
 * スラッシュコマンドをサーバー（ギルド）に登録する。
 * コマンド定義や config/tournament.json の format を変えたら再実行すること。
 */
import { REST, Routes } from 'discord.js';
import { commands } from '../commands';
import { env, loadTournamentConfig } from '../config';

async function main(): Promise<void> {
  if (!env.token || !env.clientId || !env.guildId) throw new Error('DISCORD_TOKEN / DISCORD_CLIENT_ID / DISCORD_GUILD_ID を設定してください');
  loadTournamentConfig();
  const body = commands.map((c) => c.data.toJSON());
  const rest = new REST().setToken(env.token);
  await rest.put(Routes.applicationGuildCommands(env.clientId, env.guildId), { body });
  console.log(`registered ${body.length} commands: ${body.map((b) => '/' + b.name).join(' ')}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
