import { createSharedDoingsController } from './shared-doings';
import { createStoriesController } from './stories';
import { createHardQuestionsController } from './hard-questions';
import {createStemsController} from './stems';
import {createScaleController} from './scale';
import {createAsksController} from './asks';
import {createLoveWordsController} from './love-words';
import { createNotificationPreferencesController } from './notification-preferences';
import { createArrivalController } from './arrival';
import { createPartingsController } from './partings';
import { createMorningDraftController } from './morning-draft';
import type { BodyDigest } from '../chat/edit-knowledge';
import { createMorningDiscussionsController } from './morning-discussions';
import { createMorningPreparedController } from './morning-prepared';
import { createMorningsController } from './mornings';
import { createInvitationController, type InvitationHost } from './invitations-controller';
import { createCareController } from './care';
import { createLettersController } from './letters';
import { createTasksController } from './tasks';
import { createWishesController } from './wishes';
import { createDatesController } from './dates';
import { createMemoriesController } from './memories';
import { createSongsController } from './songs';
import { createBlindController } from './blind';
import { createLeaveController, type LeaveHost } from './leave';
import type { SyntheticConfig } from './config';

export type PairFeaturesHost = InvitationHost & Pick<LeaveHost, 'suspend' | 'finish'>;
/** Compose pair features without taking ownership of authentication or request state. */
export function createPairFeatures(config: SyntheticConfig, host: PairFeaturesHost,
  request: (request: Request) => Promise<Response>, commandId: () => string, digest?: BodyDigest) {
  const sharedDoings = createSharedDoingsController(config, host, request, commandId);
  const stories = createStoriesController(config, host, request, commandId);
  const hardQuestions = createHardQuestionsController(config, host, request, commandId);
  const stems = createStemsController(config,host,request,commandId);
  const scale = createScaleController(config,host,request,commandId);
  const asks = createAsksController(config,host,request,commandId);
  const loveWords = createLoveWordsController(config,host,request,commandId);
  const invitations = createInvitationController(config, host, request, commandId);
  const care = createCareController(config, host, request, commandId);
  const letters = createLettersController(config, host, request, commandId);
  const tasks = createTasksController(config, host, request, commandId);
  const wishes = createWishesController(config, host, request, commandId);
  const notificationPreferences = createNotificationPreferencesController(config, host, request, commandId);
  const arrival = createArrivalController(config, host, request, commandId);
  const partings = createPartingsController(config, host, request, commandId);
  const dates = createDatesController(config, host, request, commandId);
  const memories = createMemoriesController(config, host, request, commandId);
  const songs = createSongsController(config, host, request, commandId);
  const blind = createBlindController(config, host, request, commandId);
  const mornings = createMorningsController(config, host, request, commandId);
  const morningDraft = createMorningDraftController(config, host, request, commandId);
  const morningPrepared = createMorningPreparedController(config, host, request, commandId);
  const morningDiscussions = createMorningDiscussionsController(config, host, request, commandId, digest);
  const leave = createLeaveController(config, host, request, commandId);
  const ordinary = [sharedDoings,hardQuestions,stories,stems,scale,asks,loveWords,notificationPreferences, arrival, partings, invitations, care, letters, tasks, wishes, dates, memories, songs, blind, mornings, morningDraft, morningPrepared, morningDiscussions];
  return {
    actions: { sharedDoings: sharedDoings.actions, hardQuestions: hardQuestions.actions, stories: stories.actions, stems: stems.actions, scale: scale.actions, asks: asks.actions, loveWords: loveWords.actions, notificationPreferences: notificationPreferences.actions, arrival: arrival.actions, partings: partings.actions, invitations: invitations.actions, care: care.actions, letters: letters.actions,
      tasks: tasks.actions, wishes: wishes.actions, dates: dates.actions, memories: memories.actions,
      songs: songs.actions, blind: blind.actions, mornings: mornings.actions, morningDraft: morningDraft.actions, morningPrepared: morningPrepared.actions, morningDiscussions: morningDiscussions.actions, leave: leave.actions },
    resetLeave: leave.reset,
    unresolvedLeave: leave.unresolved,
    resetOrdinary() { for (const feature of ordinary) feature.reset(); },
    sync() { for (const feature of ordinary) feature.sync(); leave.sync(); },
  };
}
