import type { Guild } from 'discord.js';
import { env, getTournament } from '../config';
import type { AppContext } from '../context';
import type { TeamWithPlayers } from '../db';
import { t, type MessageKey } from '../i18n';
import { createLogger } from '../logger';
import { notifyOps, ts } from '../utils/discord';

const log = createLogger('entry');

export class EntryError extends Error {
  constructor(
    public readonly key: MessageKey,
    public readonly params: Record<string, string | number> = {},
  ) {
    super(key);
  }
  get userMessage(): string {
    return t(this.key, this.params);
  }
}

const EPIC_ID = /^[0-9a-f]{32}$/i;

/** 「表示名」または「表示名, EpicアカウントID」形式の入力を分解する */
export function parseEpicInput(text: string): { epicName: string; epicId: string | null } {
  const trimmed = text.trim();
  const idx = trimmed.lastIndexOf(',');
  if (idx >= 0) {
    const maybeId = trimmed.slice(idx + 1).trim();
    if (EPIC_ID.test(maybeId)) return { epicName: trimmed.slice(0, idx).trim(), epicId: maybeId.toLowerCase() };
  }
  return { epicName: trimmed, epicId: null };
}

export function formatEpicInput(epicName: string, epicId: string | null): string {
  return epicId ? `${epicName}, ${epicId}` : epicName;
}

/** 受付中かどうか（締切日時・open フラグ） */
export function assertEntryOpen(now = new Date()): void {
  const cfg = getTournament().entry;
  if (!cfg.open) throw new EntryError('entry.closed');
  if (cfg.deadline && now.getTime() > Date.parse(cfg.deadline)) {
    throw new EntryError('entry.deadlinePassed', { deadline: ts(cfg.deadline) });
  }
}

export interface MemberInput {
  discordId: string;
  epicName: string;
  epicId: string | null;
}

function validateMembers(members: MemberInput[]): void {
  const requireId = getTournament().entry.requireEpicId;
  for (const m of members) {
    if (!m.epicName) throw new EntryError('entry.epicNameEmpty', { user: `<@${m.discordId}>` });
    if (requireId && !m.epicId) throw new EntryError('entry.epicIdRequired', { user: `<@${m.discordId}>` });
  }
}

async function setParticipantRole(guild: Guild | null, discordIds: string[], add: boolean): Promise<void> {
  if (!guild || !env.participantRoleId) return;
  for (const id of discordIds) {
    try {
      const member = await guild.members.fetch(id);
      if (add) await member.roles.add(env.participantRoleId);
      else await member.roles.remove(env.participantRoleId);
    } catch (e) {
      log.warn(`failed to ${add ? 'add' : 'remove'} participant role for ${id}`, e);
    }
  }
}

export async function registerTeam(
  ctx: AppContext,
  guild: Guild | null,
  input: { teamName: string; captainId: string; members: MemberInput[] },
): Promise<{ team: TeamWithPlayers; waitlistPosition: number | null }> {
  assertEntryOpen();
  const name = input.teamName.trim();
  if (await ctx.repo.getTeamByName(name)) throw new EntryError('entry.teamNameTaken', { team: name });
  for (const m of input.members) {
    const existing = await ctx.repo.findTeamByDiscordId(m.discordId);
    if (existing) throw new EntryError('entry.alreadyRegistered', { user: `<@${m.discordId}>`, team: existing.name });
  }
  validateMembers(input.members);

  const active = await ctx.repo.countTeams('active');
  const status = active < getTournament().entry.maxTeams ? 'active' : 'waitlist';
  const team = await ctx.repo.createTeam({ name, status, captainDiscordId: input.captainId, players: input.members });
  await ctx.repo.audit('entry.create', input.captainId, { teamId: team.id, name, status, members: input.members });
  log.info(`team registered: ${team.id} ${name} (${status})`);

  let waitlistPosition: number | null = null;
  if (status === 'active') {
    await setParticipantRole(guild, input.members.map((m) => m.discordId), true);
  } else {
    const waitlist = await ctx.repo.listTeams(['waitlist']);
    waitlistPosition = waitlist.findIndex((w) => w.id === team.id) + 1;
  }
  await notifyOps(ctx.client, t('entry.opsNotifyNew', { team: name, status: t(status === 'active' ? 'entry.statusActive' : 'entry.statusWaitlist') }));
  return { team, waitlistPosition };
}

export async function updateTeamEntry(
  ctx: AppContext,
  guild: Guild | null,
  team: TeamWithPlayers,
  actorId: string,
  input: { teamName: string; epic: Map<number, { epicName: string; epicId: string | null }>; replace?: { oldId: string; newId: string } },
): Promise<string[]> {
  const notes: string[] = [];
  const name = input.teamName.trim();
  if (name.toLowerCase() !== team.name.toLowerCase()) {
    const other = await ctx.repo.getTeamByName(name);
    if (other && other.id !== team.id) throw new EntryError('entry.teamNameTaken', { team: name });
  }

  if (input.replace) {
    const target = team.players.find((p) => p.discordId === input.replace!.oldId);
    if (!target) throw new EntryError('entry.memberNotInTeam', { user: `<@${input.replace.oldId}>` });
    const existing = await ctx.repo.findTeamByDiscordId(input.replace.newId);
    if (existing) throw new EntryError('entry.alreadyRegistered', { user: `<@${input.replace.newId}>`, team: existing.name });
  }

  validateMembers(
    team.players.map((p) => ({ discordId: p.discordId, ...(input.epic.get(p.id) ?? { epicName: p.epicName, epicId: p.epicId }) })),
  );

  const before = { name: team.name, players: team.players };
  await ctx.repo.updateTeam(team.id, { name });
  for (const p of team.players) {
    const e = input.epic.get(p.id);
    if (e) await ctx.repo.updatePlayer(p.id, { epicName: e.epicName, epicId: e.epicId });
  }
  if (input.replace) {
    const target = team.players.find((p) => p.discordId === input.replace!.oldId)!;
    await ctx.repo.updatePlayer(target.id, { discordId: input.replace.newId });
    if (team.captainDiscordId === input.replace.oldId) await ctx.repo.updateTeam(team.id, { captainDiscordId: input.replace.newId });
    if (team.status === 'active') {
      await setParticipantRole(guild, [input.replace.oldId], false);
      await setParticipantRole(guild, [input.replace.newId], true);
    }
    notes.push(t('entry.memberReplaced', { old: `<@${input.replace.oldId}>`, new: `<@${input.replace.newId}>` }));
  }
  const after = await ctx.repo.getTeam(team.id);
  await ctx.repo.audit('entry.update', actorId, { teamId: team.id, before, after });
  return notes;
}

export async function cancelTeam(ctx: AppContext, guild: Guild | null, team: TeamWithPlayers, actorId: string): Promise<TeamWithPlayers | null> {
  const wasActive = team.status === 'active';
  await ctx.repo.updateTeam(team.id, { status: 'cancelled' });
  await ctx.repo.audit('entry.cancel', actorId, { teamId: team.id, name: team.name });
  if (wasActive) await setParticipantRole(guild, team.players.map((p) => p.discordId), false);
  await notifyOps(ctx.client, t('entry.opsNotifyCancel', { team: team.name, user: `<@${actorId}>` }));

  // 空いた枠をキャンセル待ちの先頭チームに回す
  if (!wasActive) return null;
  const next = await ctx.repo.firstWaitlistTeam();
  if (!next || (await ctx.repo.countTeams('active')) >= getTournament().entry.maxTeams) return null;
  await ctx.repo.updateTeam(next.id, { status: 'active' });
  await ctx.repo.audit('entry.promote', 'system', { teamId: next.id });
  await setParticipantRole(guild, next.players.map((p) => p.discordId), true);
  const message = t('entry.promoted', { team: next.name });
  await notifyOps(ctx.client, message);
  for (const p of next.players) {
    await ctx.client.users.send(p.discordId, message).catch(() => log.warn(`could not DM ${p.discordId}`));
  }
  return next;
}
