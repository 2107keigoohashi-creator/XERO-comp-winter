import {
  type Client,
  type GuildMember,
  type Interaction,
  type MessageCreateOptions,
  type SendableChannels,
  MessageFlags,
} from 'discord.js';
import { env } from '../config';
import { t, type MessageKey } from '../i18n';
import { createLogger } from '../logger';

const log = createLogger('discord');

export async function fetchSendableChannel(client: Client, channelId: string | null): Promise<SendableChannels | null> {
  if (!channelId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isSendable()) return channel;
    log.warn(`channel ${channelId} is not sendable`);
  } catch (e) {
    log.error(`failed to fetch channel ${channelId}`, e);
  }
  return null;
}

export async function sendTo(client: Client, channelId: string | null, payload: string | MessageCreateOptions) {
  const channel = await fetchSendableChannel(client, channelId);
  if (!channel) return null;
  try {
    return await channel.send(typeof payload === 'string' ? { content: payload, allowedMentions: { parse: [] } } : payload);
  } catch (e) {
    log.error(`failed to send message to ${channelId}`, e);
    return null;
  }
}

/** 運営チャンネルへ通知（メンションは飛ばさない） */
export function notifyOps(client: Client, payload: string | MessageCreateOptions) {
  return sendTo(client, env.opsChannelId, payload);
}

/** 配信者/実況者チャンネルへ通知 */
export function notifyCaster(client: Client, payload: string | MessageCreateOptions) {
  return sendTo(client, env.casterChannelId, payload);
}

function hasAnyRole(member: GuildMember | null | undefined, roleIds: string[]): boolean {
  if (!member) return false;
  return roleIds.some((id) => member.roles.cache.has(id));
}

async function resolveMember(interaction: Interaction): Promise<GuildMember | null> {
  if (!interaction.inGuild() || !interaction.guild) return null;
  const m = interaction.member;
  if (m && 'roles' in m && !Array.isArray(m.roles)) return m as GuildMember;
  return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}

export async function isOps(interaction: Interaction): Promise<boolean> {
  return hasAnyRole(await resolveMember(interaction), env.opsRoleIds);
}

export async function isHost(interaction: Interaction): Promise<boolean> {
  return hasAnyRole(await resolveMember(interaction), [...env.opsRoleIds, ...env.hostRoleIds]);
}

type Repliable = Extract<Interaction, { reply: unknown }>;

/** 本人にだけ見えるメッセージで返信（defer 済みでも OK） */
export async function replyEphemeral(interaction: Repliable, content: string): Promise<void> {
  const payload = { content, allowedMentions: { parse: [] as never[] } };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

/** 運営権限チェック。権限が無ければエフェメラルで拒否して false を返す。 */
export async function requireOps(interaction: Repliable, key: MessageKey = 'common.noPermission'): Promise<boolean> {
  if (await isOps(interaction)) return true;
  await replyEphemeral(interaction, t(key));
  return false;
}

export async function requireHost(interaction: Repliable): Promise<boolean> {
  if (await isHost(interaction)) return true;
  await replyEphemeral(interaction, t('common.noPermissionHost'));
  return false;
}

/** Discord の相対タイムスタンプ表記 */
export function ts(date: Date | string | number, style: 'F' | 'f' | 'R' | 't' | 'D' = 'f'): string {
  const ms = typeof date === 'number' ? date : new Date(date).getTime();
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
