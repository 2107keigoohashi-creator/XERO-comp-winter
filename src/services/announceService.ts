import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
} from 'discord.js';
import { getTournament } from '../config';
import type { AppContext } from '../context';
import { renderTemplate, templateVariables } from '../core/template';
import type { Template } from '../db';
import { t } from '../i18n';
import { createLogger } from '../logger';
import { fetchSendableChannel, requireOps, sendTo, truncate, ts } from '../utils/discord';
import { getStandings } from './standingsService';

const log = createLogger('announce');

export const TEMPLATE_BUTTON_PREFIX = 'tpl:';
const PANEL_MESSAGE_KEY = 'announce:panel:message';
const PANEL_CHANNEL_KEY = 'announce:panel:channel';

/** テンプレートで使える変数の一覧（説明付き） */
export const TEMPLATE_VARIABLES: Record<string, string> = {
  tournament_name: '大会名',
  match_number: '次の試合番号（確定済み試合数 + 1）',
  start_time: '次のラウンドの開始時刻',
  round_name: '次のラウンド名',
  top3: '現在の上位3チーム',
  team_count: '参加チーム数',
  total_matches: '総試合数',
};

export async function buildTemplateVariables(ctx: AppContext): Promise<Record<string, string>> {
  const cfg = getTournament();
  const approved = (await ctx.repo.listMatches()).filter((m) => m.status === 'approved').length;
  const nextRound = cfg.rounds
    .filter((r) => Date.parse(r.startAt) > Date.now() - 3 * 3600_000)
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))[0];
  const standings = await getStandings(ctx);
  const top3 = standings
    .filter((s) => s.matches > 0)
    .slice(0, 3)
    .map((s) => `${s.rank}位 ${s.teamName}（${s.totalPoints}pt）`)
    .join('\n');
  return {
    tournament_name: cfg.name,
    match_number: String(Math.min(approved + 1, cfg.totalMatches)),
    start_time: nextRound ? ts(nextRound.startAt, 'F') : '-',
    round_name: nextRound?.name ?? '-',
    top3: top3 || '-',
    team_count: String(await ctx.repo.countTeams('active')),
    total_matches: String(cfg.totalMatches),
  };
}

async function buildPanel(ctx: AppContext) {
  const templates = await ctx.repo.listTemplates();
  const shown = templates.slice(0, 25);
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < shown.length; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        shown.slice(i, i + 5).map((tpl) =>
          new ButtonBuilder()
            .setCustomId(`${TEMPLATE_BUTTON_PREFIX}send:${tpl.id}`)
            .setLabel(truncate(tpl.name, 80))
            .setStyle(ButtonStyle.Primary),
        ),
      ),
    );
  }
  let description = templates.length ? t('template.panelDescription') : t('template.panelEmpty');
  if (templates.length > 25) description += '\n' + t('template.tooMany');
  const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle(t('template.panelTitle')).setDescription(description);
  return { embeds: [embed], components: rows };
}

export async function postPanel(ctx: AppContext, channelId: string): Promise<boolean> {
  const message = await sendTo(ctx.client, channelId, await buildPanel(ctx));
  if (!message) return false;
  await ctx.repo.setSetting(PANEL_MESSAGE_KEY, message.id);
  await ctx.repo.setSetting(PANEL_CHANNEL_KEY, channelId);
  return true;
}

/** テンプレートの追加・編集・削除時にパネルのボタンを更新する */
export async function refreshPanel(ctx: AppContext): Promise<void> {
  const messageId = await ctx.repo.getSetting(PANEL_MESSAGE_KEY);
  const channelId = await ctx.repo.getSetting(PANEL_CHANNEL_KEY);
  if (!messageId || !channelId) return;
  const channel = await fetchSendableChannel(ctx.client, channelId);
  if (!channel || !('messages' in channel)) return;
  try {
    const message = await channel.messages.fetch(messageId);
    await message.edit(await buildPanel(ctx));
  } catch (e) {
    log.warn('failed to refresh announce panel', e);
  }
}

export async function renderForSend(ctx: AppContext, tpl: Template): Promise<{ text: string; unresolved: string[] }> {
  const vars = await buildTemplateVariables(ctx);
  const text = renderTemplate(tpl.body, vars);
  const unresolved = templateVariables(tpl.body).filter((v) => !(v in vars));
  return { text, unresolved };
}

/** パネルのボタン: 送信ボタン → 確認ダイアログ → 確定で送信 */
export async function handleTemplateButton(ctx: AppContext, interaction: ButtonInteraction): Promise<void> {
  if (!(await requireOps(interaction))) return;
  const [, action, idRaw] = interaction.customId.split(':');
  const tpl = await ctx.repo.getTemplate(Number(idRaw));

  if (action === 'cancel') {
    await interaction.update({ content: t('common.cancelled'), embeds: [], components: [] });
    return;
  }
  if (!tpl) {
    await interaction.reply({ content: t('template.notFound', { name: idRaw }), flags: MessageFlags.Ephemeral });
    return;
  }

  const { text, unresolved } = await renderForSend(ctx, tpl);
  if (action === 'send') {
    const preview = new EmbedBuilder().setColor(0x9b59b6).setTitle(tpl.name).setDescription(truncate(text, 4096));
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${TEMPLATE_BUTTON_PREFIX}confirm:${tpl.id}`).setLabel(t('common.confirm')).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${TEMPLATE_BUTTON_PREFIX}cancel:${tpl.id}`).setLabel(t('common.cancel')).setStyle(ButtonStyle.Secondary),
    );
    let content = t('template.confirm', { channel: tpl.channelId });
    if (unresolved.length) content += '\n' + t('template.unresolved', { vars: unresolved.map((v) => `{${v}}`).join(', ') });
    await interaction.reply({ content, embeds: [preview], components: [buttons], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'confirm') {
    // テンプレート本文に書かれたメンションはそのまま通知する（@everyone を含む告知を想定）
    const sent = await sendTo(ctx.client, tpl.channelId, { content: text, allowedMentions: { parse: ['roles', 'users', 'everyone'] } });
    if (!sent) {
      await interaction.update({ content: t('common.error'), embeds: [], components: [] });
      return;
    }
    await ctx.repo.audit('template.send', interaction.user.id, { templateId: tpl.id, name: tpl.name, channelId: tpl.channelId });
    await interaction.update({ content: t('template.sent', { name: tpl.name, channel: tpl.channelId }), embeds: [], components: [] });
  }
}
