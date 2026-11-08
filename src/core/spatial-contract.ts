import { z } from 'zod';
import { communicationSchema, spatialEventSchema, spatialPlanSchema, spatialResolutionSchema, spatialSpeechSchema } from '../shared/spatial-schema.js';
import type { WorldState } from '../shared/world-schema.js';
import { worldEventSchema } from '../shared/world-schema.js';
import type { Utterance } from '../shared/types.js';
import type { ExperimentSpec } from '../shared/schema.js';
import { contactPossible, type localContext } from './perception.js';
export const WORLD_CONTRACT_VERSION = 'world-contract/1';
export const SPATIAL_CONTRACT_VERSION = 'spatial-contract/2';
export const ARRIVAL_CONTRACT_VERSION = 'spatial-contract/3';
export const SPATIAL_CHOICE_VERSION = 'spatial-choice/3';

export function spatialChoiceContract(view: ReturnType<typeof localContext>, actor: string) {
  const targetList = (ids: string[]) => ids.length ? z.array(z.enum(ids)).max(ids.length) : communicationSchema.shape.targetNpcIds.max(0);
  const nearby = view.nearbyNpcs.map(n => n.id);
  const whisper = view.nearbyNpcs.filter(n => n.locationId === (view.location?.id ?? null)).map(n => n.id);
  const modes: z.ZodType[] = [
    communicationSchema.extend({mode:z.literal('none'), targetNpcIds:targetList([]), channelId:z.null()}),
    communicationSchema.extend({mode:z.literal('local'), targetNpcIds:targetList(nearby), channelId:z.null()}),
  ];
  if (whisper.length) modes.push(communicationSchema.extend({mode:z.literal('whisper'), targetNpcIds:targetList(whisper).min(1), channelId:z.null()}));
  for (const c of view.channels) modes.push(communicationSchema.extend({mode:z.literal('channel'),
    targetNpcIds:targetList(c.memberNpcIds.filter(id => id !== actor)), channelId:z.literal(c.id)}));
  const destinations = view.routes.map(route => route.toLocationId);
  return z.toJSONSchema(z.object({
    ...spatialSpeechSchema.shape,
    activityChoice:view.ongoingActivity ? z.enum(['continue','cancel']) : z.literal('start'),
    communication:z.union(modes),
    moveToLocationId:destinations.length ? z.enum(destinations).nullable() : z.null(),
  }));
}

export function groundedEvents(spatial: boolean, eligible: Utterance[], actors: string[]) {
  const base = spatial ? spatialEventSchema : worldEventSchema;
  const events: z.ZodType[] = [
    base.extend({type:z.enum(['observation','external_signal']), npcId:z.null(), evidence:z.null()}),
    base.extend({type:z.literal('physical_effect'), npcId:z.enum(actors), evidence:z.null()}),
  ];
  for (const u of eligible) {
    const evidence = [u.action,u.speech].map(text => text.trim().slice(0,500)).filter(Boolean);
    if (!evidence.length) continue;
    events.push(base.extend({type:z.literal('actor_result'), npcId:z.literal(u.speakerId), evidence:z.enum(evidence),
      ...(spatial && {sourceUtteranceId:z.literal(u.id)})}));
  }
  return z.array(z.union(events)).max(spatial ? 100 : 50);
}

// IDs that refer to existing records are finite choices, independent of the
// language or genre of a scene. New facts and processes keep author-chosen IDs.
export function spatialContract(phase: string, spec: ExperimentSpec, state: WorldState, choices: string[], history: Utterance[], checkArrivals=false) {
  if (phase === 'plan') {
    const items = choices.map(id => {
      const u = history.find(u => u.id === id)!;
      const observers = [...new Set([...(u.perception?.speechRecipientIds ?? []),...(u.perception?.actionRecipientIds ?? [])])];
      const base = spatialPlanSchema.shape.plans.element;
      return base.extend({utteranceId:z.literal(id), reactionNpcIds:observers.length ? z.array(z.enum(observers)).max(observers.length) : base.shape.reactionNpcIds.max(0),
        movementStarts:u.spatialIntent?.moveToLocationId ? z.boolean() : z.literal(false),
        speechSeconds:u.speech.trim() ? base.shape.speechSeconds : z.literal(0)});
    });
    return z.toJSONSchema(spatialPlanSchema.extend({ plans:z.array(items.length === 1 ? items[0] : z.union(items)).length(items.length) }));
  }
  const pending = state.spatial!.activities.filter(a => a.status === 'pending');
  const ids = pending.map(a => a.id);
  const inTransit = state.spatial!.positions.flatMap(p => p.transit ? [p.transit.activityId] : []);
  const fields = spatialResolutionSchema.shape;
  const completed = fields.completedActivities.element.extend({id:z.enum(ids)});
  const updates = pending.map(a => {
    const eligible = state.spatial!.positions.map(p => p.npcId).filter(id => id !== a.npcId &&
      !a.offeredNpcIds.includes(id) && !a.waitingNpcIds.includes(id) && contactPossible(spec,state,a.npcId,id));
    return fields.activityUpdates.element.extend({id:z.literal(a.id),requestNpcIds:eligible.length
      ? z.array(z.enum(eligible)).max(eligible.length) : fields.activityUpdates.element.shape.requestNpcIds.max(0)});
  });
  const move = fields.movements.element.extend({
    activityId:inTransit.length ? z.enum(inTransit).nullable() : z.null(),
    kind:inTransit.length ? fields.movements.element.shape.kind : z.literal('forced'),
  });
  const arrivals: z.ZodType[] = [fields.movements.element.extend({kind:z.literal('forced'),activityId:z.null()})];
  if (checkArrivals) for (const position of state.spatial!.positions) {
    const activity=pending.find(a=>a.id===position.transit?.activityId && a.npcId===position.npcId);
    if (!activity?.moveToLocationId || activity.readyAtSeconds>state.virtualSeconds || activity.waitingNpcIds.length) continue;
    arrivals.push(fields.movements.element.extend({kind:z.literal('requested'),activityId:z.literal(activity.id),
      npcId:z.literal(activity.npcId),toLocationId:z.literal(activity.moveToLocationId)}));
  }
  return z.toJSONSchema(spatialResolutionSchema.extend({
    events:groundedEvents(true,history.filter(u => choices.includes(u.id)),state.spatial!.positions.map(p => p.npcId)),
    completedActivities:ids.length ? z.array(completed).max(ids.length) : fields.completedActivities.max(0),
    activityUpdates:updates.length ? z.array(updates.length === 1 ? updates[0] : z.union(updates)).max(ids.length) : fields.activityUpdates.max(0),
    movements:z.array(checkArrivals ? z.union(arrivals) : move).max(30),
  }));
}
