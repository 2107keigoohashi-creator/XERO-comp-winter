import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { env } from '../config';
import { t } from '../i18n';
import { buildStandingsCsv, buildStandingsEmbed, postFinalResults, setupStandingsMessage } from '../services/standingsService';
import { replyEphemeral, requireOps } from '../utils/discord';
import type { Command } from './types';

export const standingsSetupCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('standings-setup')
    .setDescription('【運営】自動更新される順位表メッセージを設置します')
    .addChannelOption((o) => o.setName('channel').setDescription('設置先（省略時は STANDINGS_CHANNEL_ID）').addChannelTypes(ChannelType.GuildText)),
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    const channelId = interaction.options.getChannel('channel')?.id ?? env.standingsChannelId;
    if (!channelId) return replyEphemeral(interaction, t('common.channelMissing', { name: 'STANDINGS_CHANNEL_ID' }));
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ok = await setupStandingsMessage(ctx, channelId);
    await interaction.editReply(ok ? t('standings.setupDone') : t('common.error'));
  },
};

export const standingsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('standings')
    .setDescription('現在の順位表を表示します（自分だけに表示）'),
  async execute(ctx, interaction) {
    await interaction.reply({ embeds: [await buildStandingsEmbed(ctx)], flags: MessageFlags.Ephemeral });
  },
};

export const standingsExportCommand: Command = {
  data: new SlashCommandBuilder().setName('standings-export').setDescription('【運営】全チームの順位表を CSV で出力します'),
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    await interaction.reply({ content: t('standings.exported'), files: [await buildStandingsCsv(ctx)], flags: MessageFlags.Ephemeral });
  },
};

export const finalResultsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('final-results')
    .setDescription('【運営】最終結果を告知チャンネルに投稿します')
    .addIntegerOption((o) => o.setName('top').setDescription('表示するチーム数（既定 10）').setMinValue(1).setMaxValue(50)),
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ok = await postFinalResults(ctx, interaction.options.getInteger('top') ?? 10);
    await ctx.repo.audit('final.post', interaction.user.id, {});
    await interaction.editReply(ok ? t('standings.finalPosted') : t('common.channelMissing', { name: 'ANNOUNCE_CHANNEL_ID' }));
  },
};
