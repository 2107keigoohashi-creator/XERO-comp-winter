import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { env, getTournament, loadTournamentConfig } from '../config';
import { t } from '../i18n';
import { createLogger } from '../logger';
import { toDirectUrl } from '../replay/download';
import { fixResult, recalculateAll } from '../services/resultService';
import { handleMatchButton, MATCH_BUTTON_PREFIX, publishPreview, reparseMatch, submitReplay, SubmitError, type Progress } from '../services/replayService';
import { replyEphemeral, requireHost, requireOps, truncate } from '../utils/discord';
import { autocompleteTeam, resolveTeamOption } from './shared';
import type { ButtonHandler, Command } from './types';

const log = createLogger('cmd:replay');

export const submitReplayCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('submit-replay')
    .setDescription('【運営/ホスト】試合のリプレイ(.replay)を送信して結果を解析します')
    .addIntegerOption((o) => o.setName('match').setDescription('試合番号').setRequired(true).setMinValue(1))
    .addAttachmentOption((o) => o.setName('file').setDescription('.replay ファイル'))
    .addStringOption((o) => o.setName('url').setDescription('ファイルが大きい場合: Google Drive 等の共有/直リンクURL')),
  async execute(ctx, interaction) {
    if (!(await requireHost(interaction))) return;
    const matchNumber = interaction.options.getInteger('match', true);
    const file = interaction.options.getAttachment('file');
    const url = interaction.options.getString('url');
    if (!file && !url) return replyEphemeral(interaction, t('replay.needFileOrUrl'));
    if (file && !file.name.toLowerCase().endsWith('.replay')) return replyEphemeral(interaction, t('replay.notReplayFile', { name: file.name }));
    if (file && file.size > env.replayMaxSizeMb * 1024 * 1024) return replyEphemeral(interaction, t('replay.tooLarge', { mb: env.replayMaxSizeMb }));

    // 進捗を知らせるため公開メッセージで応答し、その後は同じメッセージを編集していく
    await interaction.deferReply();
    const startedAt = Date.now();
    const replyId = (await interaction.fetchReply()).id;
    // インタラクションのトークンは15分で失効するため、それ以降は通常のメッセージ編集に切り替える
    const progress: Progress = async (content) => {
      if (Date.now() - startedAt < 14 * 60_000) {
        await interaction.editReply({ content, allowedMentions: { parse: [] } });
      } else {
        const channel = await ctx.client.channels.fetch(interaction.channelId);
        if (channel?.isTextBased()) await (await channel.messages.fetch(replyId)).edit({ content, allowedMentions: { parse: [] } });
      }
    };
    try {
      await submitReplay(ctx, {
        matchNumber,
        fileUrl: file ? file.url : toDirectUrl(url!),
        fileName: file ? file.name : `match${matchNumber}.replay`,
        sourceUrl: url,
        uploadedBy: interaction.user.id,
        progress,
      });
    } catch (e) {
      if (e instanceof SubmitError) return interaction.editReply(e.message);
      log.error('submit-replay failed', e);
      return interaction.editReply(t('common.error'));
    }
  },
};

export const replayAdminCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('replay')
    .setDescription('【運営】保存済みリプレイの管理')
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('試合に送信されたリプレイ一覧')
        .addIntegerOption((o) => o.setName('match').setDescription('試合番号').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('reparse')
        .setDescription('保存済みリプレイを再解析してプレビューを作り直します')
        .addIntegerOption((o) => o.setName('match').setDescription('試合番号').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('exclude')
        .setDescription('誤って送信したリプレイを統合対象から外します')
        .addIntegerOption((o) => o.setName('id').setDescription('受付ID').setRequired(true)),
    ),
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === 'exclude') {
      const id = interaction.options.getInteger('id', true);
      const replay = await ctx.repo.getReplay(id);
      if (!replay) return interaction.editReply(`#${id} not found`);
      const match = (await ctx.repo.getMatch(replay.matchId))!;
      if (match.status === 'approved') return interaction.editReply(t('replay.matchApproved', { match: match.matchNumber }));
      await ctx.repo.updateReplay(id, { excluded: true });
      await ctx.repo.audit('replay.exclude', interaction.user.id, { replayId: id });
      await publishPreview(ctx, match);
      return interaction.editReply(t('common.done'));
    }

    const matchNumber = interaction.options.getInteger('match', true);
    const match = await ctx.repo.getMatchByNumber(matchNumber);
    if (!match) return interaction.editReply(t('common.matchNotFound', { match: matchNumber }));

    if (sub === 'reparse') {
      if (match.status === 'approved') return interaction.editReply(t('replay.matchApproved', { match: matchNumber }));
      const count = await reparseMatch(ctx, matchNumber, interaction.user.id);
      return interaction.editReply(count ? t('replay.reparseQueued', { match: matchNumber, count }) : t('replay.noParsed'));
    }

    const replays = await ctx.repo.listReplays(match.id);
    const lines = replays.map(
      (r) =>
        `\`#${r.id}\` ${r.parseStatus}${r.excluded ? ' (excluded)' : ''} — <@${r.uploadedBy}> — session \`${r.sessionId ?? '-'}\`${r.error ? `\n　⚠️ ${truncate(r.error, 150)}` : ''}`,
    );
    return interaction.editReply({ content: truncate(`**Match ${matchNumber}** (${match.status})\n${lines.join('\n') || t('common.none')}`, 2000), allowedMentions: { parse: [] } });
  },
};

export const matchButton: ButtonHandler = {
  prefix: MATCH_BUTTON_PREFIX,
  handle: (ctx, interaction) => handleMatchButton(ctx, interaction),
};

export const resultFixCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('result-fix')
    .setDescription('【運営】試合結果を手動で修正/入力します（履歴が残ります）')
    .addIntegerOption((o) => o.setName('match').setDescription('試合番号').setRequired(true).setMinValue(1))
    .addStringOption((o) => o.setName('team').setDescription('チーム').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('reason').setDescription('修正理由').setRequired(true))
    .addIntegerOption((o) => o.setName('placement').setDescription('順位').setMinValue(1).setMaxValue(100))
    .addIntegerOption((o) => o.setName('kills').setDescription('チーム合計キル数').setMinValue(0).setMaxValue(200))
    .addBooleanOption((o) => o.setName('delete').setDescription('このチームの結果を削除する')),
  autocomplete: (ctx, interaction) => autocompleteTeam(ctx, interaction, ['active', 'cancelled']),
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    const matchNumber = interaction.options.getInteger('match', true);
    if (matchNumber > getTournament().totalMatches) return replyEphemeral(interaction, t('replay.matchOutOfRange', { max: getTournament().totalMatches }));
    const team = await resolveTeamOption(ctx, interaction);
    if (!team) return;
    const placement = interaction.options.getInteger('placement');
    const kills = interaction.options.getInteger('kills');
    const remove = interaction.options.getBoolean('delete') ?? false;
    if (!remove && placement == null && kills == null) return replyEphemeral(interaction, t('result.fixNeedValue'));

    await interaction.deferReply();
    const after = await fixResult(ctx, {
      matchNumber,
      teamId: team.id,
      placement: placement ?? undefined,
      kills: kills ?? undefined,
      remove,
      reason: interaction.options.getString('reason', true),
      actorId: interaction.user.id,
    });
    await interaction.editReply(
      after
        ? t('result.fixed', { match: matchNumber, team: team.name, placement: after.placement ?? '-', kills: after.kills ?? '-', points: after.totalPoints })
        : t('result.fixDeleted', { match: matchNumber, team: team.name }),
    );
  },
};

export const resultShowCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('result-show')
    .setDescription('【運営】試合ごとの結果内訳（順位P・キルP）を表示します')
    .addIntegerOption((o) => o.setName('match').setDescription('試合番号').setRequired(true).setMinValue(1)),
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    const matchNumber = interaction.options.getInteger('match', true);
    const match = await ctx.repo.getMatchByNumber(matchNumber);
    if (!match) return replyEphemeral(interaction, t('common.matchNotFound', { match: matchNumber }));
    const teams = new Map((await ctx.repo.listTeams(['active', 'waitlist', 'cancelled'])).map((team) => [team.id, team.name]));
    const rows = await ctx.repo.listResults(match.id);
    const lines = rows.map(
      (r) =>
        `\`${String(r.placement ?? '-').padStart(3)}位\` ${teams.get(r.teamId) ?? r.teamId} — 💀${r.kills ?? '-'} / 順位P ${r.placementPoints} + キルP ${r.killPoints} = **${r.totalPoints}**`,
    );
    const embed = new EmbedBuilder()
      .setTitle(t('result.showTitle', { match: matchNumber, status: match.status }))
      .setDescription(truncate(lines.join('\n') || t('common.none'), 4096));
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

export const recalculateCommand: Command = {
  data: new SlashCommandBuilder().setName('recalculate').setDescription('【運営】保存済みの順位・キルから現在のルールでポイントを再計算します'),
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // ルール変更を反映するため設定ファイルを読み直してから再計算する
    loadTournamentConfig();
    const count = await recalculateAll(ctx, interaction.user.id);
    await interaction.editReply(t('result.recalculated', { count }));
  },
};
