import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type Client,
} from 'discord.js';
import { env, getTournament, type RoundConfig } from '../config';
import type { AppContext } from '../context';
import { t } from '../i18n';
import { createLogger } from '../logger';
import { fetchSendableChannel, notifyCaster, notifyOps, replyEphemeral, sendTo, ts } from '../utils/discord';

const log = createLogger('checkin');

export const CHECKIN_BUTTON_PREFIX = 'checkin:';

export function findRound(round: number): RoundConfig | undefined {
  return getTournament().rounds.find((r) => r.round === round);
}

/** 試合番号が属するラウンド */
export function roundForMatch(matchNumber: number): RoundConfig | undefined {
  return getTournament().rounds.find((r) => r.matches.includes(matchNumber));
}

function minutesBefore(round: RoundConfig, minutes: number): number {
  return Date.parse(round.startAt) - minutes * 60_000;
}

async function progressText(ctx: AppContext, round: number): Promise<string> {
  const teams = await ctx.repo.listTeams(['active']);
  const checked = (await ctx.repo.listCheckins(round)).filter((c) => c.status === 'checked_in').length;
  return t('checkin.progress', { count: checked, total: teams.length });
}

async function buildCheckinMessage(ctx: AppContext, round: RoundConfig, closed: boolean) {
  const embed = new EmbedBuilder()
    .setColor(closed ? 0x808080 : 0x2ecc71)
    .setTitle(t('checkin.title', { round: round.name }))
    .setDescription(
      t('checkin.description', {
        start: ts(round.startAt, 'F'),
        close: ts(minutesBefore(round, round.checkinCloseMinutesBefore), 'R'),
      }),
    )
    .setFooter({ text: await progressText(ctx, round.round) });
  const button = new ButtonBuilder()
    .setCustomId(`${CHECKIN_BUTTON_PREFIX}${round.round}`)
    .setLabel(t('checkin.button'))
    .setStyle(ButtonStyle.Success)
    .setDisabled(closed);
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] };
}

export async function postCheckin(ctx: AppContext, round: RoundConfig): Promise<boolean> {
  const msg = await sendTo(ctx.client, env.checkinChannelId, {
    ...(await buildCheckinMessage(ctx, round, false)),
    content: env.participantRoleId ? `<@&${env.participantRoleId}>` : undefined,
    allowedMentions: { roles: env.participantRoleId ? [env.participantRoleId] : [] },
  });
  if (!msg) return false;
  await ctx.repo.setSetting(`checkin:${round.round}:message`, msg.id);
  await ctx.repo.setSetting(`checkin:${round.round}:closed`, null);
  log.info(`posted checkin for round ${round.round}`);
  return true;
}

async function refreshCheckinMessage(ctx: AppContext, round: RoundConfig): Promise<void> {
  const messageId = await ctx.repo.getSetting(`checkin:${round.round}:message`);
  const channel = await fetchSendableChannel(ctx.client, env.checkinChannelId);
  if (!messageId || !channel || !('messages' in channel)) return;
  const closed = (await ctx.repo.getSetting(`checkin:${round.round}:closed`)) != null;
  try {
    const message = await channel.messages.fetch(messageId);
    await message.edit(await buildCheckinMessage(ctx, round, closed));
  } catch (e) {
    log.warn(`failed to refresh checkin message for round ${round.round}`, e);
  }
}

export async function handleCheckinButton(ctx: AppContext, interaction: ButtonInteraction): Promise<void> {
  const roundNo = Number(interaction.customId.slice(CHECKIN_BUTTON_PREFIX.length));
  const round = findRound(roundNo);
  if (!round) return replyEphemeral(interaction, t('checkin.roundNotFound', { round: roundNo }));
  if (await ctx.repo.getSetting(`checkin:${roundNo}:closed`)) return replyEphemeral(interaction, t('checkin.closed'));

  const team = await ctx.repo.findTeamByDiscordId(interaction.user.id);
  if (!team || team.status !== 'active') return replyEphemeral(interaction, t('checkin.notRegistered'));

  const existing = (await ctx.repo.listCheckins(roundNo)).find((c) => c.teamId === team.id && c.status === 'checked_in');
  if (existing) return replyEphemeral(interaction, t('checkin.already', { team: team.name }));

  await ctx.repo.upsertCheckin({ teamId: team.id, round: roundNo, status: 'checked_in', discordId: interaction.user.id });
  await replyEphemeral(interaction, t('checkin.success', { team: team.name }));
  await refreshCheckinMessage(ctx, round);
}

/** チェックインを締め切り、未チェックインのチームを欠場扱いにして運営へ通知する */
export async function closeCheckin(ctx: AppContext, round: RoundConfig): Promise<void> {
  await ctx.repo.setSetting(`checkin:${round.round}:closed`, new Date().toISOString());
  const teams = await ctx.repo.listTeams(['active']);
  const checkins = await ctx.repo.listCheckins(round.round);
  const checkedIn = new Set(checkins.filter((c) => c.status === 'checked_in').map((c) => c.teamId));
  const absent = teams.filter((team) => !checkedIn.has(team.id));
  for (const team of absent) {
    await ctx.repo.upsertCheckin({ teamId: team.id, round: round.round, status: 'absent', discordId: null });
  }
  await ctx.repo.audit('checkin.close', 'system', { round: round.round, absent: absent.map((a) => a.id) });
  await refreshCheckinMessage(ctx, round);
  await sendTo(ctx.client, env.checkinChannelId, t('checkin.closedMessage', { count: checkedIn.size, total: teams.length }));
  await notifyOps(
    ctx.client,
    absent.length
      ? t('checkin.absentNotify', { round: round.name, teams: absent.map((a) => a.name).join(', ') })
      : t('checkin.allCheckedIn', { round: round.name }),
  );
}

/** 欠場扱いのチームID（そのラウンドに属する試合の照合で「見つからない」警告を出さないため） */
export async function absentTeamIds(ctx: AppContext, matchNumber: number): Promise<Set<number>> {
  const round = roundForMatch(matchNumber);
  if (!round) return new Set();
  return new Set((await ctx.repo.listCheckins(round.round)).filter((c) => c.status === 'absent').map((c) => c.teamId));
}

export async function checkinStatusText(ctx: AppContext, round: RoundConfig): Promise<string> {
  const teams = await ctx.repo.listTeams(['active']);
  const checkins = new Map((await ctx.repo.listCheckins(round.round)).map((c) => [c.teamId, c]));
  const lines = teams.map((team) => {
    const c = checkins.get(team.id);
    const mark = c?.status === 'checked_in' ? '✅' : c?.status === 'absent' ? '🚫' : '⬜';
    return `${mark} ${team.name}`;
  });
  return `**${t('checkin.statusTitle', { round: round.name })}**\n${lines.join('\n') || t('common.none')}`;
}

// ---------------- スケジューラ ----------------

interface ScheduledEvent {
  key: string;
  at: number;
  /** この時刻を過ぎたら実行しない（再起動時に古いイベントを誤発火させないため） */
  until: number;
  run: () => Promise<unknown>;
}

function eventsFor(ctx: AppContext, round: RoundConfig): ScheduledEvent[] {
  const start = Date.parse(round.startAt);
  const close = minutesBefore(round, round.checkinCloseMinutesBefore);
  const mention = env.participantRoleId ? `<@&${env.participantRoleId}>` : '';
  const events: ScheduledEvent[] = [
    {
      key: `round:${round.round}:checkin_open`,
      at: minutesBefore(round, round.checkinOpenMinutesBefore),
      until: close,
      run: () => postCheckin(ctx, round),
    },
    { key: `round:${round.round}:checkin_close`, at: close, until: start + 6 * 3600_000, run: () => closeCheckin(ctx, round) },
    {
      key: `round:${round.round}:start`,
      at: start,
      until: start + 3600_000,
      run: () =>
        notifyCaster(ctx.client, t('result.casterRoundStart', { round: round.name, start: ts(start, 'F'), matches: round.matches.join(', ') })),
    },
  ];
  for (const minutes of round.reminderMinutesBefore) {
    events.push({
      key: `round:${round.round}:reminder:${minutes}`,
      at: minutesBefore(round, minutes),
      until: start,
      run: () =>
        sendTo(ctx.client, env.checkinChannelId, {
          content: t('checkin.reminder', { mention, round: round.name, minutes, start: ts(start, 't') }),
          allowedMentions: { roles: env.participantRoleId ? [env.participantRoleId] : [] },
        }),
    });
  }
  return events;
}

export async function runScheduledEvents(ctx: AppContext, now = Date.now()): Promise<void> {
  for (const round of getTournament().rounds) {
    for (const event of eventsFor(ctx, round).sort((a, b) => a.at - b.at)) {
      if (now < event.at) continue;
      const settingKey = `event:${event.key}`;
      if (await ctx.repo.getSetting(settingKey)) continue;
      // 先にフラグを立てて二重実行を防ぐ
      await ctx.repo.setSetting(settingKey, new Date(now).toISOString());
      if (now > event.until) {
        log.warn(`skip stale event ${event.key}`);
        continue;
      }
      log.info(`run scheduled event ${event.key}`);
      await event.run().catch((e) => log.error(`scheduled event ${event.key} failed`, e));
    }
  }
}

export function startScheduler(ctx: AppContext, client: Client, intervalMs = 30_000): NodeJS.Timeout {
  const tick = () => {
    if (!client.isReady()) return;
    runScheduledEvents(ctx).catch((e) => log.error('scheduler tick failed', e));
  };
  tick();
  return setInterval(tick, intervalMs);
}
