import { MessageFlags, type Interaction } from 'discord.js';
import { buttonHandlers, commands, modalHandlers } from './commands';
import type { AppContext } from './context';
import { t } from './i18n';
import { createLogger } from './logger';

const log = createLogger('interaction');

const commandMap = new Map(commands.map((c) => [c.data.name, c]));

async function replyError(interaction: Interaction): Promise<void> {
  if (!interaction.isRepliable()) return;
  const payload = { content: t('common.error'), flags: MessageFlags.Ephemeral } as const;
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    /* 応答期限切れなど */
  }
}

export async function handleInteraction(ctx: AppContext, interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commandMap.get(interaction.commandName);
      if (!command) return;
      log.info(`/${interaction.commandName} by ${interaction.user.id}`);
      await command.execute(ctx, interaction);
    } else if (interaction.isAutocomplete()) {
      await commandMap.get(interaction.commandName)?.autocomplete?.(ctx, interaction);
    } else if (interaction.isButton()) {
      const handler = buttonHandlers.find((h) => interaction.customId.startsWith(h.prefix));
      log.info(`button ${interaction.customId} by ${interaction.user.id}`);
      await handler?.handle(ctx, interaction);
    } else if (interaction.isModalSubmit()) {
      const handler = modalHandlers.find((h) => interaction.customId.startsWith(h.prefix));
      log.info(`modal ${interaction.customId} by ${interaction.user.id}`);
      await handler?.handle(ctx, interaction);
    }
  } catch (e) {
    log.error(`interaction failed (${interaction.type})`, e);
    await replyError(interaction);
  }
}
