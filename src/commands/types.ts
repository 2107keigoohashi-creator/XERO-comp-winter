import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { AppContext } from '../context';

export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute(ctx: AppContext, interaction: ChatInputCommandInteraction): Promise<unknown>;
  autocomplete?(ctx: AppContext, interaction: AutocompleteInteraction): Promise<unknown>;
}

/** customId の先頭一致で振り分けるボタン/モーダルのハンドラ */
export interface ComponentHandler<T> {
  prefix: string;
  handle(ctx: AppContext, interaction: T): Promise<unknown>;
}

export type ButtonHandler = ComponentHandler<ButtonInteraction>;
export type ModalHandler = ComponentHandler<ModalSubmitInteraction>;
