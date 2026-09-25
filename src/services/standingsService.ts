import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { env, getTournament } from '../config';
import type { AppContext } from '../context';
import { toCsv } from '../core/csv';
import { computeStandings, type StandingRow } from '../core/standings';
import { t } from '../i18n';
import { createLogger } from '../logger';
import { fetchSendableChannel, sendTo, truncate, ts } from '../utils/discord';

const log = createLogger('standings');

const MESSAGE_KEY = 'standings:message';
const CHANNEL_KEY = 'standings:channel';

export async function getStandings(ctx: AppContext): Promise<StandingRow[]> {
  const results = await ctx.repo.listApprovedResults();
  const penalties = await ctx.repo.listPenalties();
  const withResults = new Set([...results.map((r) => r.teamId), ...penalties.map((p) => p.teamId)]);
  // 参加中のチーム + 途中で取り消されたが結果が残っているチーム
  const teams = (await ctx.repo.listTeams(['active', 'cancelled'])).filter((team) => team.status === 'active' || withResults.has(team.id));
  return computeStandings(
    teams.map((team) => ({ id: team.id, name: team.name })),
    results.map((r) => ({ teamId: r.teamId, matchNumber: r.matchNumber, placement: r.placement, kills: r.kills, totalPoints: r.totalPoints })),
    penalties.map((p) => ({ teamId: p.teamId, points: p.points })),
    getTournament().scoring.tiebreakers,
  );
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function formatRow(row: StandingRow): string {
  return t('standings.row', {
    rank: row.rank,
    team: row.teamName,
    points: fmt(row.totalPoints),
    matches: row.matches,
    wins: row.victoryRoyales,
    kills: row.totalKills,
    penalty: row.penaltyPoints ? t('standings.penalty', { points: fmt(row.penaltyPoints) }) : '',
  });
}

export async function buildStandingsEmbed(ctx: AppContext, opts: { top?: number; title?: string } = {}): Promise<EmbedBuilder> {
  const cfg = getTournament();
  const rows = await getStandings(ctx);
  const top = opts.top ?? cfg.standings.displayTop;
  const played = (await ctx.repo.listMatches()).filter((m) => m.status === 'approved').length;
  const shown = rows.slice(0, top);

  let body = shown.length && played ? shown.map(formatRow).join('\n') : t('standings.empty');
  if (played && rows.length > top) body += '\n' + t('standings.more', { count: rows.length - top });

  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(opts.title ?? t('standings.title', { name: cfg.name }))
    .setDescription(truncate(`${t('standings.description', { played, total: cfg.totalMatches, updated: ts(Date.now(), 'R') })}\n\n${body}`, 4096));
}

/** 固定表示している順位表メッセージを最新の内容に編集する */
export async function updateStandingsMessage(ctx: AppContext): Promise<void> {
  const messageId = await ctx.repo.getSetting(MESSAGE_KEY);
  const channelId = (await ctx.repo.getSetting(CHANNEL_KEY)) ?? env.standingsChannelId;
  if (!messageId || !channelId) return;
  const channel = await fetchSendableChannel(ctx.client, channelId);
  if (!channel || !('messages' in channel)) return;
  const embed = await buildStandingsEmbed(ctx);
  try {
    const message = await channel.messages.fetch(messageId);
    await message.edit({ embeds: [embed] });
  } catch (e) {
    log.warn('standings message not found; posting a new one', e);
    await setupStandingsMessage(ctx, channelId);
  }
}

export async function setupStandingsMessage(ctx: AppContext, channelId: string): Promise<boolean> {
  const message = await sendTo(ctx.client, channelId, { embeds: [await buildStandingsEmbed(ctx)] });
  if (!message) return false;
  await message.pin().catch((e) => log.warn('failed to pin standings message', e));
  await ctx.repo.setSetting(MESSAGE_KEY, message.id);
  await ctx.repo.setSetting(CHANNEL_KEY, channelId);
  return true;
}

export async function buildStandingsCsv(ctx: AppContext): Promise<AttachmentBuilder> {
  const rows = await getStandings(ctx);
  const teams = new Map((await ctx.repo.listTeams(['active', 'waitlist', 'cancelled'])).map((team) => [team.id, team]));
  const csv = toCsv(
    t('standings.csvHeader').split(','),
    rows.map((r) => [
      r.rank,
      r.teamName,
      fmt(r.totalPoints),
      fmt(r.matchPoints),
      fmt(r.penaltyPoints),
      r.matches,
      r.victoryRoyales,
      r.totalKills,
      r.avgKills.toFixed(2),
      Number.isFinite(r.avgPlacement) ? r.avgPlacement.toFixed(2) : '',
      (teams.get(r.teamId)?.players ?? []).map((p) => p.epicName).join(' / '),
    ]),
  );
  return new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `standings_${new Date().toISOString().slice(0, 10)}.csv` });
}

export async function postFinalResults(ctx: AppContext, top: number): Promise<boolean> {
  const cfg = getTournament();
  const rows = await getStandings(ctx);
  const medals = ['🥇', '🥈', '🥉'];
  const podium = rows
    .slice(0, top)
    .map((r) => `${medals[r.rank - 1] ?? `**${r.rank}.**`} ${r.teamName} — **${fmt(r.totalPoints)}pt**（👑${r.victoryRoyales} / 💀${r.totalKills}）`)
    .join('\n');
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle(t('standings.finalTitle', { name: cfg.name }))
    .setDescription(truncate(podium || t('standings.empty'), 4096))
    .setTimestamp(new Date());
  const message = await sendTo(ctx.client, env.announceChannelId, { embeds: [embed], files: [await buildStandingsCsv(ctx)] });
  return message != null;
}
