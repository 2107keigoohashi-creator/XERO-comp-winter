import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTournamentConfig } from '../src/config';
import type { AppContext } from '../src/context';
import type { ParsedReplay } from '../src/core/types';
import { SqliteRepository } from '../src/db/sqlite';
import { JobQueue } from '../src/replay/queue';
import { buildPreview } from '../src/services/replayService';
import { player } from './helpers';

describe('buildPreview（複数リプレイの統合 → 照合 → 検証）', () => {
  it('2本のリプレイを統合してチーム結果と警告を作る', async () => {
    loadTournamentConfig(path.join(__dirname, '..', 'config', 'tournament.json'));
    const repo = new SqliteRepository(':memory:');
    const ctx = { repo, queue: new JobQueue(1) } as unknown as AppContext;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xero-test-'));

    const alpha = await repo.createTeam({
      name: 'Alpha',
      status: 'active',
      captainDiscordId: 'a1',
      players: [
        { discordId: 'a1', epicName: 'A1', epicId: null },
        { discordId: 'a2', epicName: 'A2', epicId: null },
      ],
    });
    const bravo = await repo.createTeam({
      name: 'Bravo',
      status: 'active',
      captainDiscordId: 'b1',
      players: [{ discordId: 'b1', epicName: 'B1', epicId: null }],
    });
    const match = await repo.getOrCreateMatch(1);

    const save = async (i: number, parsed: ParsedReplay) => {
      const jsonPath = path.join(dir, `${i}.parsed.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(parsed));
      const r = await repo.createReplay({ matchId: match.id, filePath: path.join(dir, `${i}.replay`), sourceUrl: null, fileHash: `h${i}`, uploadedBy: 'host' });
      await repo.updateReplay(r.id, { parseStatus: 'parsed', parsedJsonPath: jsonPath, sessionId: parsed.sessionId });
    };
    // Alpha 視点: 遠くの B1 の情報が欠けている
    await save(1, {
      sessionId: 'S',
      parser: 't',
      players: [
        player({ name: 'A1', partyNumber: 1, placement: 1, kills: 3, isReplayOwner: true }),
        player({ name: 'A2', partyNumber: 1, placement: 1, kills: 2 }),
        player({ name: 'B1', partyNumber: 2, placement: null, kills: null }),
        ...Array.from({ length: 10 }, (_, i) => player({ name: `Other${i}`, partyNumber: 10 + i, placement: 3 + i, kills: 0 })),
      ],
    });
    // Bravo 視点
    await save(2, {
      sessionId: 'S',
      parser: 't',
      players: [
        player({ name: 'B1', partyNumber: 2, placement: 2, kills: 4, isReplayOwner: true }),
        player({ name: 'A1', partyNumber: 1, placement: 1, kills: 1 }),
      ],
    });

    const preview = await buildPreview(ctx, match);
    expect(preview?.sessionId).toBe('S');
    expect(preview?.results).toEqual([
      { teamId: alpha.id, placement: 1, kills: 5 },
      { teamId: bravo.id, placement: 2, kills: 4 },
    ]);
    const codes = preview!.issues.map((i) => i.code);
    expect(codes.filter((c) => c === 'UNKNOWN_PLAYER')).toHaveLength(10);
    expect(codes).toContain('MERGE_KILLS_DIFFER');
    expect(codes).not.toContain('MISSING_PLACEMENT');

    // 別セッションのリプレイは統合しない
    await save(3, { sessionId: 'OTHER', parser: 't', players: [player({ name: 'A1', partyNumber: 1, placement: 50, kills: 0 })] });
    const again = await buildPreview(ctx, (await repo.getMatch(match.id))!);
    expect(again!.issues.map((i) => i.code)).toContain('SESSION_MISMATCH');
    expect(again!.results[0].placement).toBe(1);

    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
