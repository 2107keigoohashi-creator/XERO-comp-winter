import { Client, Events, GatewayIntentBits } from 'discord.js';
import { env, loadTournamentConfig } from './config';
import { initContext } from './context';
import { handleInteraction } from './interactions';
import { createLogger } from './logger';
import { startScheduler } from './services/checkinService';
import { updateStandingsMessage } from './services/standingsService';

const log = createLogger('main');

async function main(): Promise<void> {
  if (!env.token) throw new Error('DISCORD_TOKEN is not set (.env を確認してください)');
  const tournament = loadTournamentConfig();
  log.info(`tournament config loaded: ${tournament.name} (${tournament.format}, ${tournament.totalMatches} matches)`);

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  const ctx = initContext(client);
  log.info(`replay parser: ${ctx.parser.name}`);

  client.once(Events.ClientReady, async (c) => {
    log.info(`logged in as ${c.user.tag}`);
    startScheduler(ctx, client);
    await updateStandingsMessage(ctx).catch((e) => log.warn('initial standings update failed', e));
  });
  client.on(Events.InteractionCreate, (interaction) => void handleInteraction(ctx, interaction));
  client.on(Events.Error, (e) => log.error('client error', e));

  const shutdown = async (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    await client.destroy();
    ctx.repo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

  await client.login(env.token);
}

main().catch((e) => {
  log.error('fatal', e);
  process.exit(1);
});
