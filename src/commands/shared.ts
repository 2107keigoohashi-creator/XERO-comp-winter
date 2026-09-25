import crypto from 'node:crypto';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { AppContext } from '../context';
import type { TeamStatus, TeamWithPlayers } from '../db';
import { t } from '../i18n';
import { replyEphemeral } from '../utils/discord';

/** チーム名オプションの入力補完 */
export async function autocompleteTeam(ctx: AppContext, interaction: AutocompleteInteraction, statuses: TeamStatus[] = ['active', 'waitlist']) {
  const focused = String(interaction.options.getFocused()).toLowerCase();
  const teams = await ctx.repo.listTeams(statuses);
  await interaction.respond(
    teams
      .filter((team) => team.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((team) => ({ name: team.name.slice(0, 100), value: team.name.slice(0, 100) })),
  );
}

export async function resolveTeamOption(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
  option = 'team',
  required = true,
): Promise<TeamWithPlayers | null> {
  const name = interaction.options.getString(option, required);
  if (!name) return null;
  const team = await ctx.repo.getTeamByName(name);
  if (!team) await replyEphemeral(interaction, t('common.teamNotFound', { team: name }));
  return team;
}

/** モーダルを跨いでデータを受け渡すための短命ストア（customId の 100 文字制限対策） */
export class PendingStore<T> {
  private items = new Map<string, { value: T; expires: number }>();

  constructor(private readonly ttlMs = 15 * 60_000) {}

  put(value: T): string {
    this.sweep();
    const token = crypto.randomBytes(6).toString('hex');
    this.items.set(token, { value, expires: Date.now() + this.ttlMs });
    return token;
  }

  take(token: string): T | null {
    const item = this.items.get(token);
    this.items.delete(token);
    return item && item.expires > Date.now() ? item.value : null;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.items) if (v.expires <= now) this.items.delete(k);
  }
}
