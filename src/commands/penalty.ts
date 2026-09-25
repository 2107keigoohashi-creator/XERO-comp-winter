import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { t } from '../i18n';
import { updateStandingsMessage } from '../services/standingsService';
import { notifyOps, requireOps, truncate } from '../utils/discord';
import { autocompleteTeam, resolveTeamOption } from './shared';
import type { Command } from './types';

export const penaltyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('penalty')
    .setDescription('【運営】ペナルティ・警告の記録')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('ペナルティを記録します（減点は順位表に反映）')
        .addStringOption((o) => o.setName('team').setDescription('チーム').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('reason').setDescription('理由').setRequired(true))
        .addNumberOption((o) => o.setName('points').setDescription('減点（0 なら警告のみ）').setRequired(true).setMinValue(0)),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('ペナルティを取り消します')
        .addIntegerOption((o) => o.setName('id').setDescription('ペナルティID').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('ペナルティ一覧')
        .addStringOption((o) => o.setName('team').setDescription('チーム').setAutocomplete(true)),
    ),
  autocomplete: (ctx, interaction) => autocompleteTeam(ctx, interaction, ['active', 'waitlist', 'cancelled']),
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const team = await resolveTeamOption(ctx, interaction);
      if (!team) return;
      const points = interaction.options.getNumber('points', true);
      const reason = interaction.options.getString('reason', true);
      const penalty = await ctx.repo.addPenalty({ teamId: team.id, points, reason, createdBy: interaction.user.id });
      await ctx.repo.audit('penalty.add', interaction.user.id, penalty);
      await updateStandingsMessage(ctx);
      const message = t('penalty.added', { team: team.name, points, reason, id: penalty.id });
      await notifyOps(ctx.client, message);
      return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'remove') {
      const id = interaction.options.getInteger('id', true);
      const removed = await ctx.repo.deletePenalty(id);
      if (!removed) return interaction.reply({ content: t('penalty.notFound', { id }), flags: MessageFlags.Ephemeral });
      await ctx.repo.audit('penalty.remove', interaction.user.id, removed);
      await updateStandingsMessage(ctx);
      return interaction.reply({ content: t('penalty.removed', { id }), flags: MessageFlags.Ephemeral });
    }

    const teamName = interaction.options.getString('team');
    const team = teamName ? await resolveTeamOption(ctx, interaction) : null;
    if (teamName && !team) return;
    const teams = new Map((await ctx.repo.listTeams(['active', 'waitlist', 'cancelled'])).map((x) => [x.id, x.name]));
    const penalties = await ctx.repo.listPenalties(team?.id);
    const lines = penalties.map((p) => t('penalty.row', { id: p.id, team: teams.get(p.teamId) ?? p.teamId, points: p.points, reason: p.reason, by: p.createdBy }));
    return interaction.reply({
      content: truncate(`**${t('penalty.listTitle')}**\n${lines.join('\n') || t('common.none')}`, 2000),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};
