import type { ScoringConfig } from '../src/config';
import type { ParsedPlayer } from '../src/core/types';

export const scoring: ScoringConfig = {
  placementPoints: { '1': 11, '2': 6, '3': 5, '4': 4, '5': 4, '6': 3, '7': 3, '8': 2, '9': 2, '10': 1 },
  pointsPerKill: 1,
  killCap: null,
  tiebreakers: ['victory_royales', 'avg_kills', 'avg_placement', 'last_match_placement'],
};

export function player(p: Partial<ParsedPlayer> & { name: string }): ParsedPlayer {
  return { epicId: null, partyNumber: null, placement: null, kills: null, isBot: false, isReplayOwner: false, ...p };
}
