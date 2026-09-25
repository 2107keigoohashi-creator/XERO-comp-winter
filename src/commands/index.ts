import { checkinButton, checkinCommand } from './checkin';
import {
  entryCancelButton,
  entryCancelCommand,
  entryCommand,
  entryEditCommand,
  entryEditModal,
  entryListCommand,
  entryModal,
} from './entry';
import { penaltyCommand } from './penalty';
import {
  matchButton,
  recalculateCommand,
  replayAdminCommand,
  resultFixCommand,
  resultShowCommand,
  submitReplayCommand,
} from './replay';
import { finalResultsCommand, standingsCommand, standingsExportCommand, standingsSetupCommand } from './standings';
import {
  announcePanelCommand,
  templateAddCommand,
  templateButton,
  templateDeleteCommand,
  templateEditCommand,
  templateListCommand,
  templateModal,
} from './template';
import type { ButtonHandler, Command, ModalHandler } from './types';

export const commands: Command[] = [
  entryCommand,
  entryListCommand,
  entryEditCommand,
  entryCancelCommand,
  checkinCommand,
  submitReplayCommand,
  replayAdminCommand,
  resultFixCommand,
  resultShowCommand,
  recalculateCommand,
  standingsCommand,
  standingsSetupCommand,
  standingsExportCommand,
  finalResultsCommand,
  penaltyCommand,
  templateAddCommand,
  templateEditCommand,
  templateDeleteCommand,
  templateListCommand,
  announcePanelCommand,
];

export const buttonHandlers: ButtonHandler[] = [checkinButton, matchButton, templateButton, entryCancelButton];

export const modalHandlers: ModalHandler[] = [entryModal, entryEditModal, templateModal];
