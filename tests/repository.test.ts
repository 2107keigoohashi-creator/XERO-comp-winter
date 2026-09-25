import { describe, expect, it } from 'vitest';
import { SqliteRepository } from '../src/db/sqlite';

describe('SqliteRepository', () => {
  it('チーム登録・検索・結果・承認済み集計が動く', async () => {
    const repo = new SqliteRepository(':memory:');
    const team = await repo.createTeam({
      name: 'Alpha',
      status: 'active',
      captainDiscordId: 'u1',
      players: [
        { discordId: 'u1', epicName: 'A1', epicId: null },
        { discordId: 'u2', epicName: 'A2', epicId: 'x'.repeat(32) },
      ],
    });
    expect((await repo.findTeamByDiscordId('u2'))?.id).toBe(team.id);
    expect((await repo.getTeamByName('alpha'))?.players).toHaveLength(2);

    const m1 = await repo.getOrCreateMatch(1);
    expect((await repo.getOrCreateMatch(1)).id).toBe(m1.id);
    await repo.replaceResults(m1.id, [{ matchId: m1.id, teamId: team.id, placement: 1, kills: 3, placementPoints: 11, killPoints: 3, totalPoints: 14 }]);
    expect(await repo.listApprovedResults()).toHaveLength(0);
    await repo.updateMatch(m1.id, { status: 'approved' });
    expect((await repo.listApprovedResults())[0]).toMatchObject({ matchNumber: 1, totalPoints: 14 });

    await repo.updateTeam(team.id, { status: 'cancelled' });
    expect(await repo.findTeamByDiscordId('u1')).toBeNull();

    await repo.setSetting('k', 'v');
    expect(await repo.getSetting('k')).toBe('v');
    repo.close();
  });
});
