import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { t } from '../i18n';
import { checkinStatusText, closeCheckin, findRound, handleCheckinButton, CHECKIN_BUTTON_PREFIX, postCheckin } from '../services/checkinService';
import { replyEphemeral, requireOps, truncate } from '../utils/discord';
import type { ButtonHandler, Command } from './types';

export const checkinCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('checkin')
    .setDescription('【運営】チェックインの手動操作')
    .addSubcommand((s) =>
      s
        .setName('post')
        .setDescription('チェックインメッセージを今すぐ投稿します')
        .addIntegerOption((o) => o.setName('round').setDescription('ラウンド番号').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('close')
        .setDescription('チェックインを今すぐ締め切ります（未チェックインは欠場扱い）')
        .addIntegerOption((o) => o.setName('round').setDescription('ラウンド番号').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('status')
        .setDescription('チェックイン状況を表示します')
        .addIntegerOption((o) => o.setName('round').setDescription('ラウンド番号').setRequired(true)),
    ),
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    const roundNo = interaction.options.getInteger('round', true);
    const round = findRound(roundNo);
    if (!round) return replyEphemeral(interaction, t('checkin.roundNotFound', { round: roundNo }));
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'post') {
      const ok = await postCheckin(ctx, round);
      await ctx.repo.setSetting(`event:round:${round.round}:checkin_open`, new Date().toISOString());
      return interaction.editReply(ok ? t('checkin.posted') : t('common.channelMissing', { name: 'CHECKIN_CHANNEL_ID' }));
    }
    if (sub === 'close') {
      await closeCheckin(ctx, round);
      await ctx.repo.setSetting(`event:round:${round.round}:checkin_close`, new Date().toISOString());
      return interaction.editReply(t('common.done'));
    }
    return interaction.editReply({ content: truncate(await checkinStatusText(ctx, round), 2000), allowedMentions: { parse: [] } });
  },
};

export const checkinButton: ButtonHandler = {
  prefix: CHECKIN_BUTTON_PREFIX,
  handle: (ctx, interaction) => handleCheckinButton(ctx, interaction),
};
