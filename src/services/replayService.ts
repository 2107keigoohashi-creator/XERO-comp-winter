import fs from 'node:fs';
import path from 'node:path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type Message,
} from 'discord.js';
import { env, getTournament } from '../config';
import type { AppContext } from '../context';
import { matchPlayersToTeams } from '../core/matcher';
import { mergeReplays } from '../core/merge';
import { computePoints } from '../core/scoring';
import type { Issue, ParsedReplay, TeamMatchResult } from '../core/types';
import { validateMatch } from '../core/validation';
import type { Match, Replay } from '../db';
import { t } from '../i18n';
import { createLogger } from '../logger';
import { downloadFile, sha256File, toDirectUrl } from '../replay/download';
import { fetchSendableChannel, notifyOps, requireOps, truncate } from '../utils/discord';
import { absentTeamIds } from './checkinService';
import { approveMatch, rejectMatch } from './resultService';

const log = createLogger('replay');

export const MATCH_BUTTON_PREFIX = 'match:';

export interface MatchPreview {
  version: string;
  sessionId: string | null;
  replayIds: number[];
  results: TeamMatchResult[];
  issues: Issue[];
}

export class SubmitError extends Error {}

export type Progress = (content: string) => Promise<void>;

function replayDir(matchNumber: number): string {
  return path.join(env.dataDir, 'replays', `match_${String(matchNumber).padStart(2, '0')}`);
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(-80);
}

// ---------------- 受付 ----------------

export interface SubmitInput {
  matchNumber: number;
  fileUrl: string;
  fileName: string;
  sourceUrl: string | null;
  uploadedBy: string;
  /** 進捗を知らせるコールバック（送信コマンドの返信メッセージを編集する） */
  progress: Progress | null;
}

/**
 * リプレイを受け付けてダウンロードし、解析キューに入れる。
 * 戻り値のメッセージはユーザーへの返信内容。
 */
export async function submitReplay(ctx: AppContext, input: SubmitInput): Promise<string> {
  const cfg = getTournament();
  if (input.matchNumber < 1 || input.matchNumber > cfg.totalMatches) {
    throw new SubmitError(t('replay.matchOutOfRange', { max: cfg.totalMatches }));
  }
  const match = await ctx.repo.getOrCreateMatch(input.matchNumber);
  if (match.status === 'approved') throw new SubmitError(t('replay.matchApproved', { match: input.matchNumber }));

  const dest = path.join(replayDir(input.matchNumber), `${Date.now()}_${safeFileName(input.fileName)}`);
  try {
    await downloadFile(input.fileUrl, dest, env.replayMaxSizeMb * 1024 * 1024);
  } catch (e) {
    log.warn(`download failed (match ${input.matchNumber})`, e);
    throw new SubmitError(t('replay.downloadFailed', { reason: (e as Error).message }));
  }

  const hash = await sha256File(dest);
  const duplicate = await ctx.repo.findReplayByHash(hash);
  if (duplicate) {
    fs.rmSync(dest, { force: true });
    const dupMatch = await ctx.repo.getMatch(duplicate.matchId);
    const message = t('replay.duplicateFile', { match: dupMatch?.matchNumber ?? '?', id: duplicate.id });
    await notifyOps(ctx.client, `${message}（送信者: <@${input.uploadedBy}>）`);
    throw new SubmitError(message);
  }

  const replay = await ctx.repo.createReplay({
    matchId: match.id,
    filePath: dest,
    sourceUrl: input.sourceUrl,
    fileHash: hash,
    uploadedBy: input.uploadedBy,
  });
  if (match.status === 'rejected') await ctx.repo.updateMatch(match.id, { status: 'collecting' });
  await ctx.repo.audit('replay.submit', input.uploadedBy, { replayId: replay.id, matchNumber: input.matchNumber, sourceUrl: input.sourceUrl });

  // 進捗表示を先に「受付済み」にしてからキューに入れる（解析開始の表示と順序が逆転しないように）
  const message = t('replay.queued', { match: input.matchNumber, id: replay.id, position: ctx.queue.pending });
  await editProgress(input.progress, message);
  enqueueParse(ctx, replay, input.matchNumber, input.progress);
  return message;
}

export function enqueueParse(ctx: AppContext, replay: Replay, matchNumber: number, progress: Progress | null): number {
  return ctx.queue.push(`replay#${replay.id}`, () => processReplay(ctx, replay.id, matchNumber, progress));
}

async function editProgress(progress: Progress | null, content: string): Promise<void> {
  if (!progress) return;
  await progress(content).catch((e) => log.warn('failed to edit progress message', e));
}

// ---------------- 解析 ----------------

async function processReplay(ctx: AppContext, replayId: number, matchNumber: number, progress: Progress | null): Promise<void> {
  const replay = await ctx.repo.getReplay(replayId);
  if (!replay) return;
  await ctx.repo.updateReplay(replayId, { parseStatus: 'parsing', error: null });
  await editProgress(progress, t('replay.parsing', { match: matchNumber, id: replayId }));

  let parsed: ParsedReplay;
  const started = Date.now();
  try {
    parsed = await ctx.parser.parse(path.resolve(replay.filePath));
  } catch (e) {
    const reason = truncate((e as Error).message ?? String(e), 1500);
    log.error(`parse failed replay=${replayId} match=${matchNumber}`, e);
    await ctx.repo.updateReplay(replayId, { parseStatus: 'failed', error: reason });
    await editProgress(progress, t('replay.failed', { match: matchNumber, id: replayId, reason: truncate(reason, 300) }));
    await notifyOps(ctx.client, t('replay.failedOps', { match: matchNumber, id: replayId, user: `<@${replay.uploadedBy}>`, reason }));
    return;
  }
  log.info(`parsed replay=${replayId} players=${parsed.players.length} session=${parsed.sessionId} in ${Date.now() - started}ms`);

  // 解析結果を保存しておき、プレビュー再生成や監査に使う
  const jsonPath = replay.filePath.replace(/\.replay$/i, '') + '.parsed.json';
  fs.writeFileSync(jsonPath, JSON.stringify(parsed, null, 2));
  await ctx.repo.updateReplay(replayId, {
    parseStatus: 'parsed',
    parsedAt: new Date().toISOString(),
    parsedJsonPath: jsonPath,
    sessionId: parsed.sessionId,
  });
  await editProgress(progress, t('replay.parsed', { match: matchNumber, id: replayId }));

  const match = await ctx.repo.getMatch(replay.matchId);
  if (match) await publishPreview(ctx, match);
}

function loadParsed(replay: Replay): ParsedReplay | null {
  if (!replay.parsedJsonPath || !fs.existsSync(replay.parsedJsonPath)) return null;
  return JSON.parse(fs.readFileSync(replay.parsedJsonPath, 'utf8')) as ParsedReplay;
}

/** 試合に紐づく解析済みリプレイを全て統合し、チーム単位の結果と警告を計算する */
export async function buildPreview(ctx: AppContext, match: Match): Promise<MatchPreview | null> {
  const issues: Issue[] = [];
  const replays = (await ctx.repo.listReplays(match.id)).filter((r) => r.parseStatus === 'parsed' && !r.excluded);
  const loaded = replays.map((r) => ({ replay: r, parsed: loadParsed(r) })).filter((x): x is { replay: Replay; parsed: ParsedReplay } => !!x.parsed);
  if (loaded.length === 0) return null;

  // セッションIDの確認: 他の試合との重複 / 同じ試合内での不一致
  let sessionId = match.sessionId;
  const usable: ParsedReplay[] = [];
  for (const { replay, parsed } of loaded) {
    if (!parsed.sessionId) {
      issues.push({ level: 'warning', code: 'NO_SESSION_ID', params: { replay: replay.id } });
      usable.push(parsed);
      continue;
    }
    const other = await ctx.repo.findMatchBySession(parsed.sessionId);
    if (other && other.id !== match.id) {
      issues.push({ level: 'error', code: 'DUPLICATE_SESSION', params: { match: other.matchNumber, replay: replay.id } });
      continue;
    }
    if (!sessionId) sessionId = parsed.sessionId;
    if (parsed.sessionId !== sessionId) {
      issues.push({ level: 'error', code: 'SESSION_MISMATCH', params: { replay: replay.id, session: parsed.sessionId } });
      continue;
    }
    usable.push(parsed);
  }
  if (sessionId && sessionId !== match.sessionId) await ctx.repo.updateMatch(match.id, { sessionId });

  const merged = mergeReplays(usable);
  issues.push(...merged.issues);

  const teams = await ctx.repo.listRegisteredTeams();
  const absent = await absentTeamIds(ctx, match.matchNumber);
  const absentNames = new Set(teams.filter((team) => absent.has(team.id)).map((team) => team.name));
  const outcome = matchPlayersToTeams(merged.players, teams);
  issues.push(
    ...outcome.issues.filter(
      (i) => !((i.code === 'TEAM_NOT_FOUND' || i.code === 'MISSING_PLAYER') && absentNames.has(String(i.params.team))),
    ),
  );
  const teamNames = new Map(teams.map((team) => [team.id, team.name]));
  issues.push(...validateMatch(merged.players, outcome.results, teamNames, getTournament().validation));

  return {
    version: String(Date.now()),
    sessionId,
    replayIds: replays.map((r) => r.id),
    results: outcome.results.sort((a, b) => (a.placement ?? 999) - (b.placement ?? 999)),
    issues,
  };
}

const LEVEL_ICON: Record<Issue['level'], string> = { error: '❌', warning: '⚠️', info: 'ℹ️' };

async function buildPreviewMessage(ctx: AppContext, match: Match, preview: MatchPreview, state: 'open' | 'outdated' | 'approved' | 'rejected', actor?: string) {
  const scoring = getTournament().scoring;
  const teamNames = new Map((await ctx.repo.listTeams(['active', 'cancelled'])).map((team) => [team.id, team.name]));
  const lines = preview.results.map((r) => {
    const p = computePoints(r.placement, r.kills, scoring);
    return `\`${String(r.placement ?? '?').padStart(3)}位\` ${teamNames.get(r.teamId) ?? r.teamId} — 💀${r.kills ?? '?'} → **${p.totalPoints}pt**`;
  });
  const errors = preview.issues.filter((i) => i.level === 'error').length;
  const sorted = [...preview.issues].sort((a, b) => ['error', 'warning', 'info'].indexOf(a.level) - ['error', 'warning', 'info'].indexOf(b.level));
  const issueLines = sorted.slice(0, 15).map((i) => `${LEVEL_ICON[i.level]} ${t(`issue.${i.code}`, i.params)}`);
  if (sorted.length > 15) issueLines.push(t('replay.previewMoreIssues', { count: sorted.length - 15 }));

  const colors = { open: errors ? 0xe74c3c : 0x3498db, outdated: 0x808080, approved: 0x2ecc71, rejected: 0x95a5a6 };
  const embed = new EmbedBuilder()
    .setColor(colors[state])
    .setTitle(t('replay.previewTitle', { match: match.matchNumber }))
    .setDescription(
      truncate(
        `${t('replay.previewDescription', { replays: preview.replayIds.length, session: preview.sessionId ?? '-' })}\n\n**${t('replay.previewTeams')}**\n${lines.join('\n') || t('common.none')}`,
        4096,
      ),
    );
  if (issueLines.length) embed.addFields({ name: t('replay.previewIssues'), value: truncate(issueLines.join('\n'), 1024) });
  if (state === 'approved') embed.setFooter({ text: `✅ approved by ${actor ?? ''}` });
  if (state === 'rejected') embed.setFooter({ text: `🚫 rejected by ${actor ?? ''}` });
  if (state === 'outdated') embed.setFooter({ text: 'outdated' });

  const disabled = state !== 'open';
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MATCH_BUTTON_PREFIX}approve:${match.id}:${preview.version}`)
      .setLabel(t('replay.approve'))
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${MATCH_BUTTON_PREFIX}reject:${match.id}:${preview.version}`)
      .setLabel(t('replay.reject'))
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
  const content = state === 'open' && errors ? t('replay.hasErrors', { count: errors }) : undefined;
  return { content, embeds: [embed], components: [row], allowedMentions: { parse: [] as never[] } };
}

async function fetchOpsMessage(ctx: AppContext, messageId: string | null): Promise<Message | null> {
  if (!messageId) return null;
  const channel = await fetchSendableChannel(ctx.client, env.opsChannelId);
  if (!channel || !('messages' in channel)) return null;
  return channel.messages.fetch(messageId).catch(() => null);
}

/** プレビューを作り直して運営チャンネルに投稿する（古いプレビューのボタンは無効化） */
export async function publishPreview(ctx: AppContext, match: Match): Promise<void> {
  const preview = await buildPreview(ctx, match);
  if (!preview) return;

  const old = match.previewJson ? (JSON.parse(match.previewJson) as MatchPreview) : null;
  const oldMessage = await fetchOpsMessage(ctx, match.previewMessageId);
  if (old && oldMessage) await oldMessage.edit(await buildPreviewMessage(ctx, match, old, 'outdated')).catch(() => undefined);

  const channel = await fetchSendableChannel(ctx.client, env.opsChannelId);
  if (!channel) {
    log.error('OPS_CHANNEL_ID is not configured; cannot post preview');
    return;
  }
  const fresh = (await ctx.repo.getMatch(match.id))!;
  const message = await channel.send(await buildPreviewMessage(ctx, fresh, preview, 'open'));
  await ctx.repo.updateMatch(match.id, { status: 'pending', previewJson: JSON.stringify(preview), previewMessageId: message.id });
  log.info(`preview posted match=${match.matchNumber} issues=${preview.issues.length}`);
}

// ---------------- 承認 / 却下 ----------------

export async function handleMatchButton(ctx: AppContext, interaction: ButtonInteraction): Promise<void> {
  if (!(await requireOps(interaction))) return;
  const [, action, matchIdRaw, version] = interaction.customId.split(':');
  const match = await ctx.repo.getMatch(Number(matchIdRaw));
  const preview = match?.previewJson ? (JSON.parse(match.previewJson) as MatchPreview) : null;
  if (!match || !preview || preview.version !== version || match.status !== 'pending') {
    await interaction.reply({ content: t('replay.previewOutdated'), flags: 64 });
    return;
  }
  await interaction.deferUpdate();
  const actor = interaction.user.tag;
  if (action === 'approve') {
    await approveMatch(ctx, match.id, preview.results, interaction.user.id);
    await interaction.editReply(await buildPreviewMessage(ctx, match, preview, 'approved', actor));
    await interaction.followUp({ content: t('replay.approved', { match: match.matchNumber, user: `<@${interaction.user.id}>` }), allowedMentions: { parse: [] } });
  } else {
    await rejectMatch(ctx, match.id, interaction.user.id);
    await interaction.editReply(await buildPreviewMessage(ctx, match, preview, 'rejected', actor));
    await interaction.followUp({ content: t('replay.rejected', { match: match.matchNumber, user: `<@${interaction.user.id}>` }), allowedMentions: { parse: [] } });
  }
}

/** 保存済みのリプレイを全て再解析する（解析エンジン更新後など） */
export async function reparseMatch(ctx: AppContext, matchNumber: number, actorId: string): Promise<number> {
  const match = await ctx.repo.getMatchByNumber(matchNumber);
  if (!match) return 0;
  const replays = (await ctx.repo.listReplays(match.id)).filter((r) => !r.excluded && fs.existsSync(r.filePath));
  for (const r of replays) {
    await ctx.repo.updateReplay(r.id, { parseStatus: 'queued' });
    enqueueParse(ctx, r, matchNumber, null);
  }
  await ctx.repo.audit('replay.reparse', actorId, { matchNumber, replayIds: replays.map((r) => r.id) });
  return replays.length;
}
