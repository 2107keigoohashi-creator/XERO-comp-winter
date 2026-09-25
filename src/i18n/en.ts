import type { MessageKey } from './ja';

/**
 * English messages (for future OCE/SEA participants).
 * Missing keys fall back to Japanese, so this file can be filled in gradually.
 */
export const en: Partial<Record<MessageKey, string>> = {
  'common.noPermission': '⛔ This command is for tournament staff only.',
  'common.noPermissionHost': '⛔ This command is for staff or hosts only.',
  'common.error': '⚠️ Something went wrong. Please contact the staff.',
  'entry.closed': '⛔ Registration is closed.',
  'entry.registered': '✅ Team "{team}" has been registered!',
  'checkin.button': 'Check in',
  'checkin.success': '✅ Team "{team}" has checked in!',
  'standings.title': '🏆 {name} Standings',
};
