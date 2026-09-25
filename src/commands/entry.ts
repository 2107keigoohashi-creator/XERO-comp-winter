import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type User,
} from 'discord.js';
import { getTournament, teamSize } from '../config';
import type { AppContext } from '../context';
import type { TeamWithPlayers } from '../db';
import { t } from '../i18n';
import {
  EntryError,
  assertEntryOpen,
  cancelTeam,
  formatEpicInput,
  parseEpicInput,
  registerTeam,
  updateTeamEntry,
} from '../services/entryService';
import { isOps, replyEphemeral, requireOps, truncate } from '../utils/discord';
import { PendingStore, autocompleteTeam, resolveTeamOption } from './shared';
import type { ButtonHandler, Command, ModalHandler } from './types';

const MEMBER_OPTIONS = ['member2', 'member3', 'member4'];

function epicLabel(user: { username: string; displayName?: string }): string {
  return truncate(t('entry.epicFor', { user: user.displayName ?? user.username }), 45);
}

function epicInput(customId: string, value?: string) {
  const input = new TextInputBuilder().setCustomId(customId).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80);
  if (value) input.setValue(value);
  return input;
}

async function handleError(interaction: ChatInputCommandInteraction | ModalSubmitInteraction, e: unknown): Promise<void> {
  if (e instanceof EntryError) return replyEphemeral(interaction, e.userMessage);
  throw e;
}

// ---------------- /entry ----------------

const newEntries = new PendingStore<{ captainId: string; memberIds: string[] }>();

function buildEntryCommand() {
  const builder = new SlashCommandBuilder().setName('entry').setDescription('チームで大会にエントリーします（あなたがチーム代表になります）');
  const extra = Math.max(0, Math.min(teamSize() - 1, MEMBER_OPTIONS.length));
  for (let i = 0; i < extra; i++) {
    builder.addUserOption((o) => o.setName(MEMBER_OPTIONS[i]).setDescription(`メンバー${i + 2}`).setRequired(true));
  }
  return builder;
}

export const entryCommand: Command = {
  get data() {
    return buildEntryCommand();
  },
  async execute(ctx, interaction) {
    try {
      assertEntryOpen();
      const members: User[] = [interaction.user];
      for (const name of MEMBER_OPTIONS) {
        const u = interaction.options.getUser(name);
        if (u) members.push(u);
      }
      const size = teamSize();
      if (members.length !== size) throw new EntryError('entry.wrongMemberCount', { format: getTournament().format, size });
      if (new Set(members.map((m) => m.id)).size !== members.length) throw new EntryError('entry.duplicateMember');
      if (members.some((m) => m.bot)) throw new EntryError('entry.botMember');
      for (const m of members) {
        const team = await ctx.repo.findTeamByDiscordId(m.id);
        if (team) throw new EntryError('entry.alreadyRegistered', { user: `<@${m.id}>`, team: team.name });
      }

      const token = newEntries.put({ captainId: interaction.user.id, memberIds: members.map((m) => m.id) });
      const modal = new ModalBuilder().setCustomId(`entry:new:${token}`).setTitle(t('entry.modalTitle'));
      modal.addLabelComponents(
        new LabelBuilder()
          .setLabel(t('entry.teamName'))
          .setTextInputComponent(new TextInputBuilder().setCustomId('team_name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32)),
      );
      members.forEach((m, i) =>
        modal.addLabelComponents(
          new LabelBuilder().setLabel(epicLabel(m)).setDescription(t('entry.epicDescription')).setTextInputComponent(epicInput(`epic_${i}`)),
        ),
      );
      await interaction.showModal(modal);
    } catch (e) {
      await handleError(interaction, e);
    }
  },
};

export const entryModal: ModalHandler = {
  prefix: 'entry:new:',
  async handle(ctx, interaction) {
    const pending = newEntries.take(interaction.customId.slice(this.prefix.length));
    if (!pending) return replyEphemeral(interaction, t('entry.sessionExpired'));
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const members = pending.memberIds.map((discordId, i) => ({ discordId, ...parseEpicInput(interaction.fields.getTextInputValue(`epic_${i}`)) }));
      const { team, waitlistPosition } = await registerTeam(ctx, interaction.guild, {
        teamName: interaction.fields.getTextInputValue('team_name'),
        captainId: pending.captainId,
        members,
      });
      const message = waitlistPosition
        ? t('entry.waitlisted', { team: team.name, position: waitlistPosition })
        : t('entry.registered', { team: team.name });
      await interaction.editReply({ content: `${message}\n${teamSummary(team)}`, allowedMentions: { parse: [] } });
    } catch (e) {
      await handleError(interaction, e);
    }
  },
};

function teamSummary(team: TeamWithPlayers): string {
  return team.players.map((p) => `・<@${p.discordId}> — ${p.epicName}${p.epicId ? `（${p.epicId}）` : ''}`).join('\n');
}

// ---------------- /entry-list ----------------

export const entryListCommand: Command = {
  data: new SlashCommandBuilder().setName('entry-list').setDescription('【運営】登録チーム一覧を表示します'),
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    const teams = await ctx.repo.listTeams(['active', 'waitlist']);
    const active = teams.filter((team) => team.status === 'active');
    const waitlist = teams.filter((team) => team.status === 'waitlist');
    const line = (team: TeamWithPlayers, i: number) =>
      `**${i + 1}. ${team.name}**\n${team.players.map((p) => `　<@${p.discordId}> ${p.epicName}${p.epicId ? ' ✅ID' : ''}`).join('\n')}`;
    const body = [
      ...active.map(line),
      ...(waitlist.length ? [`\n__${t('entry.statusWaitlist')}__`, ...waitlist.map(line)] : []),
    ].join('\n');

    // Embed の文字数制限に合わせて分割する
    const chunks: string[] = [];
    let current = '';
    for (const part of (body || t('entry.listEmpty')).split('\n')) {
      if ((current + '\n' + part).length > 3900) {
        chunks.push(current);
        current = part;
      } else current = current ? `${current}\n${part}` : part;
    }
    if (current) chunks.push(current);
    const title = t('entry.listTitle', { active: active.length, max: getTournament().entry.maxTeams, waitlist: waitlist.length });
    const embeds = chunks.slice(0, 10).map((c, i) => new EmbedBuilder().setColor(0x3498db).setTitle(i === 0 ? title : null).setDescription(c));
    await interaction.reply({ embeds, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};

// ---------------- /entry-edit ----------------

const edits = new PendingStore<{ teamId: number; actorId: string; replace?: { oldId: string; newId: string } }>();

/** 代表者・メンバー本人または運営が対象チームを操作できるか */
async function resolveOwnTeam(ctx: AppContext, interaction: ChatInputCommandInteraction, captainOnly: boolean): Promise<TeamWithPlayers | null> {
  const teamName = interaction.options.getString('team');
  if (teamName) {
    if (!(await requireOps(interaction))) return null;
    return resolveTeamOption(ctx, interaction);
  }
  const team = await ctx.repo.findTeamByDiscordId(interaction.user.id);
  if (!team) {
    await replyEphemeral(interaction, t('entry.notMember'));
    return null;
  }
  if (captainOnly && team.captainDiscordId !== interaction.user.id && !(await isOps(interaction))) {
    await replyEphemeral(interaction, t('entry.notCaptain'));
    return null;
  }
  return team;
}

export const entryEditCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('entry-edit')
    .setDescription('エントリー内容（チーム名・Epic名・メンバー）を修正します')
    .addUserOption((o) => o.setName('old_member').setDescription('入れ替える場合: 抜けるメンバー'))
    .addUserOption((o) => o.setName('new_member').setDescription('入れ替える場合: 新しいメンバー'))
    .addStringOption((o) => o.setName('team').setDescription('【運営】対象チーム').setAutocomplete(true)),
  autocomplete: (ctx, interaction) => autocompleteTeam(ctx, interaction),
  async execute(ctx, interaction) {
    const team = await resolveOwnTeam(ctx, interaction, true);
    if (!team) return;
    const oldMember = interaction.options.getUser('old_member');
    const newMember = interaction.options.getUser('new_member');
    let replace: { oldId: string; newId: string } | undefined;
    if (oldMember && newMember) {
      if (newMember.bot) return replyEphemeral(interaction, t('entry.botMember'));
      replace = { oldId: oldMember.id, newId: newMember.id };
      if (!team.players.some((p) => p.discordId === oldMember.id)) {
        return replyEphemeral(interaction, t('entry.memberNotInTeam', { user: `<@${oldMember.id}>` }));
      }
    }

    const token = edits.put({ teamId: team.id, actorId: interaction.user.id, replace });
    const modal = new ModalBuilder().setCustomId(`entry:edit:${token}`).setTitle(t('entry.modalEditTitle'));
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel(t('entry.teamName'))
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('team_name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32).setValue(team.name),
        ),
    );
    for (const p of team.players.slice(0, 4)) {
      const discordId = replace && p.discordId === replace.oldId ? replace.newId : p.discordId;
      const user = await ctx.client.users.fetch(discordId).catch(() => null);
      const isReplaced = replace && p.discordId === replace.oldId;
      modal.addLabelComponents(
        new LabelBuilder()
          .setLabel(epicLabel(user ?? { username: discordId }))
          .setDescription(t('entry.epicDescription'))
          .setTextInputComponent(epicInput(`epic_${p.id}`, isReplaced ? undefined : formatEpicInput(p.epicName, p.epicId))),
      );
    }
    await interaction.showModal(modal);
  },
};

export const entryEditModal: ModalHandler = {
  prefix: 'entry:edit:',
  async handle(ctx, interaction) {
    const pending = edits.take(interaction.customId.slice(this.prefix.length));
    if (!pending) return replyEphemeral(interaction, t('entry.sessionExpired'));
    const team = await ctx.repo.getTeam(pending.teamId);
    if (!team) return replyEphemeral(interaction, t('common.teamNotFound', { team: pending.teamId }));
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const epic = new Map(team.players.map((p) => [p.id, parseEpicInput(interaction.fields.getTextInputValue(`epic_${p.id}`))]));
      const notes = await updateTeamEntry(ctx, interaction.guild, team, pending.actorId, {
        teamName: interaction.fields.getTextInputValue('team_name'),
        epic,
        replace: pending.replace,
      });
      const updated = (await ctx.repo.getTeam(team.id))!;
      await interaction.editReply({
        content: [t('entry.updated', { team: updated.name }), ...notes, teamSummary(updated)].join('\n'),
        allowedMentions: { parse: [] },
      });
    } catch (e) {
      await handleError(interaction, e);
    }
  },
};

// ---------------- /entry-cancel ----------------

export const entryCancelCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('entry-cancel')
    .setDescription('エントリーを取り消します')
    .addStringOption((o) => o.setName('team').setDescription('【運営】対象チーム').setAutocomplete(true)),
  autocomplete: (ctx, interaction) => autocompleteTeam(ctx, interaction),
  async execute(ctx, interaction) {
    const team = await resolveOwnTeam(ctx, interaction, true);
    if (!team) return;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`entrycancel:yes:${team.id}`).setLabel(t('common.confirm')).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`entrycancel:no:${team.id}`).setLabel(t('common.cancel')).setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({ content: t('entry.cancelConfirm', { team: team.name }), components: [row], flags: MessageFlags.Ephemeral });
  },
};

export const entryCancelButton: ButtonHandler = {
  prefix: 'entrycancel:',
  async handle(ctx, interaction: ButtonInteraction) {
    const [, answer, teamIdRaw] = interaction.customId.split(':');
    if (answer !== 'yes') return interaction.update({ content: t('common.cancelled'), components: [] });
    const team = await ctx.repo.getTeam(Number(teamIdRaw));
    if (!team || team.status === 'cancelled') return interaction.update({ content: t('common.teamNotFound', { team: teamIdRaw }), components: [] });
    // エフェメラルの確認ボタンなので押せるのはコマンド実行者だけだが、念のため権限を再確認する
    const allowed = team.captainDiscordId === interaction.user.id || (await isOps(interaction));
    if (!allowed) return interaction.update({ content: t('entry.notCaptain'), components: [] });
    await interaction.deferUpdate();
    await cancelTeam(ctx, interaction.guild, team, interaction.user.id);
    await interaction.editReply({ content: t('entry.cancelledTeam', { team: team.name }), components: [] });
  },
};
