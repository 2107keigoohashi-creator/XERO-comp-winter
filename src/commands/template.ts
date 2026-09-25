import {
  ChannelType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
} from 'discord.js';
import type { AppContext } from '../context';
import { t } from '../i18n';
import { handleTemplateButton, postPanel, refreshPanel, TEMPLATE_BUTTON_PREFIX, TEMPLATE_VARIABLES } from '../services/announceService';
import { replyEphemeral, requireOps, truncate } from '../utils/discord';
import { PendingStore } from './shared';
import type { ButtonHandler, Command, ModalHandler } from './types';

const pending = new PendingStore<{ mode: 'add' | 'edit'; templateId?: number; name: string; channelId: string }>();

async function autocompleteTemplate(ctx: AppContext, interaction: AutocompleteInteraction) {
  const focused = String(interaction.options.getFocused()).toLowerCase();
  const templates = await ctx.repo.listTemplates();
  await interaction.respond(
    templates.filter((x) => x.name.toLowerCase().includes(focused)).slice(0, 25).map((x) => ({ name: x.name, value: x.name })),
  );
}

function bodyModal(token: string, name: string, body?: string) {
  const vars = Object.keys(TEMPLATE_VARIABLES).map((v) => `{${v}}`).join(' ');
  const input = new TextInputBuilder().setCustomId('body').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000);
  if (body) input.setValue(body);
  return new ModalBuilder()
    .setCustomId(`template:${token}`)
    .setTitle(truncate(t('template.modalTitle', { name }), 45))
    .addLabelComponents(new LabelBuilder().setLabel(t('template.body')).setDescription(truncate(vars, 100)).setTextInputComponent(input));
}

export const templateAddCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('template-add')
    .setDescription('【運営】告知テンプレートを登録します（本文はモーダルで入力）')
    .addStringOption((o) => o.setName('name').setDescription('テンプレート名（ボタンのラベル）').setRequired(true).setMaxLength(80))
    .addChannelOption((o) =>
      o.setName('channel').setDescription('送信先チャンネル').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    const name = interaction.options.getString('name', true).trim();
    if (await ctx.repo.getTemplateByName(name)) return replyEphemeral(interaction, t('template.exists', { name }));
    const token = pending.put({ mode: 'add', name, channelId: interaction.options.getChannel('channel', true).id });
    await interaction.showModal(bodyModal(token, name));
  },
};

export const templateEditCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('template-edit')
    .setDescription('【運営】告知テンプレートを編集します')
    .addStringOption((o) => o.setName('name').setDescription('テンプレート名').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('new_name').setDescription('新しいテンプレート名').setMaxLength(80))
    .addChannelOption((o) =>
      o.setName('channel').setDescription('新しい送信先チャンネル').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  autocomplete: autocompleteTemplate,
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    const name = interaction.options.getString('name', true);
    const tpl = await ctx.repo.getTemplateByName(name);
    if (!tpl) return replyEphemeral(interaction, t('template.notFound', { name }));
    const newName = interaction.options.getString('new_name')?.trim() || tpl.name;
    if (newName.toLowerCase() !== tpl.name.toLowerCase() && (await ctx.repo.getTemplateByName(newName))) {
      return replyEphemeral(interaction, t('template.exists', { name: newName }));
    }
    const token = pending.put({ mode: 'edit', templateId: tpl.id, name: newName, channelId: interaction.options.getChannel('channel')?.id ?? tpl.channelId });
    await interaction.showModal(bodyModal(token, newName, tpl.body));
  },
};

export const templateModal: ModalHandler = {
  prefix: 'template:',
  async handle(ctx, interaction) {
    const data = pending.take(interaction.customId.slice(this.prefix.length));
    if (!data) return replyEphemeral(interaction, t('entry.sessionExpired'));
    const body = interaction.fields.getTextInputValue('body');
    if (data.mode === 'add') {
      const tpl = await ctx.repo.createTemplate({ name: data.name, body, channelId: data.channelId, createdBy: interaction.user.id });
      await ctx.repo.audit('template.add', interaction.user.id, tpl);
    } else {
      await ctx.repo.updateTemplate(data.templateId!, { name: data.name, body, channelId: data.channelId });
      await ctx.repo.audit('template.edit', interaction.user.id, { id: data.templateId, name: data.name, channelId: data.channelId });
    }
    await refreshPanel(ctx);
    await replyEphemeral(interaction, t('template.saved', { name: data.name, channel: data.channelId }));
  },
};

export const templateDeleteCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('template-delete')
    .setDescription('【運営】告知テンプレートを削除します')
    .addStringOption((o) => o.setName('name').setDescription('テンプレート名').setRequired(true).setAutocomplete(true)),
  autocomplete: autocompleteTemplate,
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    const name = interaction.options.getString('name', true);
    const tpl = await ctx.repo.getTemplateByName(name);
    if (!tpl) return replyEphemeral(interaction, t('template.notFound', { name }));
    await ctx.repo.deleteTemplate(tpl.id);
    await ctx.repo.audit('template.delete', interaction.user.id, tpl);
    await refreshPanel(ctx);
    await replyEphemeral(interaction, t('template.deleted', { name: tpl.name }));
  },
};

export const templateListCommand: Command = {
  data: new SlashCommandBuilder().setName('template-list').setDescription('【運営】告知テンプレートと使える変数の一覧'),
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    const templates = await ctx.repo.listTemplates();
    const lines = templates.map((x) => `・**${x.name}** → <#${x.channelId}>\n　${truncate(x.body.replace(/\n/g, ' '), 80)}`);
    const vars = Object.entries(TEMPLATE_VARIABLES).map(([k, v]) => `\`{${k}}\` ${v}`);
    await interaction.reply({
      content: truncate(`**${t('template.listTitle')}**\n${lines.join('\n') || t('common.none')}\n\n**変数**\n${vars.join('\n')}`, 2000),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};

export const announcePanelCommand: Command = {
  data: new SlashCommandBuilder().setName('announce-panel').setDescription('【運営】このチャンネルにワンボタン告知パネルを設置します'),
  async execute(ctx, interaction) {
    if (!(await requireOps(interaction))) return;
    const ok = await postPanel(ctx, interaction.channelId);
    await replyEphemeral(interaction, ok ? t('template.panelPosted') : t('common.error'));
  },
};

export const templateButton: ButtonHandler = {
  prefix: TEMPLATE_BUTTON_PREFIX,
  handle: (ctx, interaction) => handleTemplateButton(ctx, interaction),
};
