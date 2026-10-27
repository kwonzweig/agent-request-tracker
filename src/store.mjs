import { actionVersionChanged } from './record-freshness.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isJournalId } from './identity.mjs';
import { evaluateStopAssessment, unresolvedDecision } from './completion.mjs';

const requestStatuses = new Set(['proposed', 'active', 'waiting', 'deferred', 'done', 'cancelled']);
const decisionStatuses = new Set(['open', 'answered', 'deferred', 'superseded', 'dismissed']);
const blockerStatuses = new Set(['open', 'resolved', 'dismissed']);
const cardStatuses = new Set(['open', 'answered', 'resolved', 'deferred', 'superseded', 'dismissed']);
const cardTypes = new Set(['suggestion', 'qa', 'note', 'completion']);
const endReasons = new Set([null, 'complete', 'decision', 'blocker', 'user_paused', 'answer_delivered', 'background', 'interrupted', 'unknown']);
const replyTargets = ['requests', 'decisions', 'blockers', 'cards'];
const collections = [...replyTargets, 'replies'];
// Unknown decision fields may describe effects; do not silently exempt them.
const presentationFields = ['attention', 'nudge', 'resolution', 'dismissal', 'urls'];
const decisionBookkeeping = new Set(['id', 'revision', 'status', 'user_answer', 'agent_assumption', 'last_changed_turn', ...presentationFields]);
const cardBookkeeping = new Set(['id', 'revision', 'status', 'user_answer', 'last_changed_turn', ...presentationFields]);
const requestOutcomeFields = ['title', 'done_when', 'scope', 'parent_id'];
const completionLifecycleFields = new Set(['id', 'status', 'resolution', 'dismissal', 'attention', 'nudge', 'last_changed_turn']);

export class JournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JournalError';
    this.code = code;
  }
}

function fail(code, message) { throw new JournalError(code, message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function positiveInt(value) { return Number.isSafeInteger(value) && value > 0; }

function isActionUrl(value) {
  // Require an explicit authority and reject text the URL parser would silently normalize.
  if (typeof value !== 'string' || !/^https?:\/\/[^\s\u0000-\u001f\u007f/?#\\]+(?:[/?#][^\s\u0000-\u001f\u007f\\]*)?(?![\s\S])/i.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function validateWorkspace(request) {
  const workspace = request.workspace;
  if (workspace == null) return;
  if (!object(workspace) || !nonempty(workspace.id) || [...workspace.id].length > 128 ||
      !isLinkUrl(workspace.url)) {
    fail('INVALID_REQUEST', `request ${request.id} workspace needs a nonblank 1–128 character display id and an absolute HTTP(S) URL without credentials`);
  }
}

function isLinkUrl(value) {
  return isActionUrl(value) && !/^https?:\/\/[^/?#]*@/i.test(value);
}

function validateUrls(record) {
  if (record.urls == null) return;
  if (!Array.isArray(record.urls) || record.urls.some(link => !object(link) || !nonempty(link.label) || !isLinkUrl(link.url))) {
    fail('INVALID_URLS', `${record.id} urls must be labeled absolute HTTP(S) URLs without credentials`);
  }
}

function validateInteraction(record) {
  validateUrls(record);
  const attention = record.attention;
  if (attention != null && (!object(attention) || !['pending', 'later', 'acknowledged'].includes(attention.state) ||
      !['user', 'agent'].includes(attention.actor) || !nonempty(attention.source) ||
      (attention.state !== 'pending' && attention.actor !== 'user') ||
      (Object.hasOwn(attention, 'reason') && !nonempty(attention.reason)))) {
    fail('INVALID_ATTENTION', `${record.id} attention needs a state, actor, source, and user provenance for Later or acknowledgment`);
  }
  const nudge = record.nudge;
  if (nudge != null && (!object(nudge) || !nonempty(nudge.text) || !['normal', 'high'].includes(nudge.priority))) {
    fail('INVALID_NUDGE', `${record.id} nudge needs text and normal or high priority`);
  }
  const resolution = record.resolution;
  if (resolution != null) {
    if (!object(resolution) || !['user', 'agent'].includes(resolution.actor) || !nonempty(resolution.source) || !nonempty(resolution.note) ||
        (Object.hasOwn(resolution, 'text') && !nonempty(resolution.text))) {
      fail('INVALID_RESOLUTION', `${record.id} resolution needs actor, source, and a nonblank note`);
    }
    if (Object.hasOwn(resolution, 'option_id')) checkId(resolution.option_id, 'resolution option id');
    if (Object.hasOwn(resolution, 'record_revision') && !positiveInt(resolution.record_revision)) {
      fail('INVALID_RESOLUTION', `${record.id} verification record_revision must be positive`);
    }
  }
  const dismissal = record.dismissal;
  if (dismissal != null) {
    if (!object(dismissal) || !['user', 'agent'].includes(dismissal.actor) || !nonempty(dismissal.source) || !nonempty(dismissal.reason)) {
      fail('INVALID_DISMISSAL', `${record.id} dismissal needs actor, source, and reason`);
    }
    if (dismissal.replacement != null) {
      if (!object(dismissal.replacement) || !['decisions', 'blockers', 'cards'].includes(dismissal.replacement.collection)) {
        fail('INVALID_DISMISSAL', `${record.id} dismissal replacement needs a card collection and id`);
      }
      checkId(dismissal.replacement.id, 'dismissal replacement id');
    }
  }
  if (record.status === 'dismissed' && !dismissal) fail('INVALID_DISMISSAL', `${record.id} dismissed outcome needs its source and reason`);
}

function validateAnswerProvenance(record, optionIds, label, code) {
  const resolution = record.resolution;
  if (resolution && record.user_answer) fail(code, `${label} cannot contain both user_answer and resolution`);
  if (resolution?.option_id != null && !optionIds.has(resolution.option_id)) fail(code, `${label} resolution names an unknown option`);
  if (record.status !== 'answered' || record.user_answer) return;
  if (resolution?.actor !== 'agent' || (!nonempty(resolution.option_id) && !nonempty(resolution.text))) {
    fail('MISSING_ANSWER', `${label} needs a referenced user answer or an explicitly attributed agent answer`);
  }
  if (code === 'INVALID_DECISION' && record.required !== false) {
    fail('MISSING_PERMISSION', `${label} requires an actual user answer; agent inference cannot supply permission`);
  }
}

// Snapshot before the first await. JSON-only input cannot change under a writer
// or serialize to a different value than the one that was validated.
function snapshotUpdate(value) {
  try {
    const copy = JSON.parse(JSON.stringify(value));
    if (!isDeepStrictEqual(value, copy)) fail('INVALID_UPDATE', 'update must contain only plain JSON values');
    return copy;
  } catch (error) {
    if (error instanceof JournalError) throw error;
    fail('INVALID_UPDATE', 'update must contain only plain JSON values');
  }
}

function checkId(id, label = 'id') {
  if (!isJournalId(id)) {
    fail('INVALID_ID', `${label} must be a safe 1–128 character identifier`);
  }
}

function statePath(dataDir, conversationId) {
  if (!nonempty(dataDir)) fail('INVALID_DATA_DIR', 'data directory is required');
  checkId(conversationId, 'conversation id');
  return path.join(path.resolve(dataDir), `${conversationId}.json`);
}

function emptyState(conversationId) {
  return { schema_version: 1, revision: 0, conversation_id: conversationId,
    requests: [], decisions: [], blockers: [], cards: [], replies: [], turn: null, history: [] };
}

function validateUnique(records, name) {
  const ids = new Set();
  for (const record of records) {
    if (!object(record)) fail('INVALID_STATE', `${name} entry must be an object`);
    checkId(record.id, `${name} id`);
    if (ids.has(record.id)) fail('DUPLICATE_ID', `duplicate ${name} id: ${record.id}`);
    ids.add(record.id);
  }
  return ids;
}

function hasEvidence(value) {
  return nonempty(value) || (Array.isArray(value) && value.length > 0 && value.every(nonempty));
}

function validateRequest(request) {
  validateWorkspace(request);
  validateUrls(request);
  if (request.parent_id !== null && request.parent_id !== undefined) checkId(request.parent_id, 'parent id');
  if (!nonempty(request.title) || !nonempty(request.source)) fail('INVALID_REQUEST', `request ${request.id} needs title and source`);
  if (!hasEvidence(request.done_when)) fail('INVALID_REQUEST', `request ${request.id} needs done_when`);
  if (!requestStatuses.has(request.status)) fail('INVALID_REQUEST', `request ${request.id} has invalid status`);
  if (request.status === 'done' && !hasEvidence(request.evidence)) fail('MISSING_EVIDENCE', `done request ${request.id} needs evidence`);
  if (request.scope_exclusion_source != null && !nonempty(request.scope_exclusion_source)) {
    fail('INVALID_REQUEST', `request ${request.id} scope exclusion needs a source reference`);
  }
}

function validateDecision(decision, requestIds) {
  validateInteraction(decision);
  checkId(decision.request_id, 'decision request id');
  if (!requestIds.has(decision.request_id)) fail('MISSING_REFERENCE', `decision ${decision.id} references missing request`);
  if (!positiveInt(decision.revision)) fail('INVALID_DECISION', `decision ${decision.id} needs a positive revision`);
  for (const field of ['question', 'why', 'no_answer_behavior']) {
    if (!nonempty(decision[field])) fail('INVALID_DECISION', `decision ${decision.id} needs ${field}`);
  }
  if (!Array.isArray(decision.options) || decision.options.length === 0) fail('INVALID_DECISION', `decision ${decision.id} needs options`);
  const optionIds = validateUnique(decision.options, `decision ${decision.id} option`);
  for (const option of decision.options) {
    if (!nonempty(option.label) || !nonempty(option.impact)) fail('INVALID_DECISION', `decision ${decision.id} option needs label and impact`);
  }
  if (decision.recommendation !== undefined && decision.recommendation !== null && !nonempty(decision.recommendation)) {
    fail('INVALID_DECISION', `decision ${decision.id} recommendation must be nonempty text`);
  }
  if (decision.required != null && typeof decision.required !== 'boolean') {
    fail('INVALID_DECISION', `decision ${decision.id} required must be boolean or null`);
  }
  if (!decisionStatuses.has(decision.status)) fail('INVALID_DECISION', `decision ${decision.id} has invalid status`);
  if (decision.user_answer !== undefined && decision.user_answer !== null) {
    const answer = decision.user_answer;
    if (!object(answer) || answer.revision !== decision.revision || !nonempty(answer.source) ||
        (!nonempty(answer.option_id) && !nonempty(answer.text))) {
      fail('STALE_ANSWER', `decision ${decision.id} answer needs a source, value, and matching revision`);
    }
    if (answer.option_id != null && !optionIds.has(answer.option_id)) {
      fail('INVALID_DECISION', `decision ${decision.id} answer names an unknown option`);
    }
  }
  validateAnswerProvenance(decision, optionIds, `decision ${decision.id}`, 'INVALID_DECISION');
  if (!['answered', 'dismissed', 'superseded'].includes(decision.status) && decision.user_answer) {
    fail('INVALID_DECISION', `decision ${decision.id} has an answer but is not answered`);
  }
}

function validateBlocker(blocker, requestIds) {
  validateInteraction(blocker);
  checkId(blocker.request_id, 'blocker request id');
  if (!requestIds.has(blocker.request_id)) fail('MISSING_REFERENCE', `blocker ${blocker.id} references missing request`);
  for (const field of ['title', 'evidence', 'next_action', 'owner']) {
    if (!nonempty(blocker[field])) fail('INVALID_BLOCKER', `blocker ${blocker.id} needs ${field}`);
  }
  if (!blockerStatuses.has(blocker.status)) fail('INVALID_BLOCKER', `blocker ${blocker.id} has invalid status`);
  if (blocker.action_url !== undefined && !isActionUrl(blocker.action_url)) {
    fail('INVALID_BLOCKER', `blocker ${blocker.id} action_url must be an absolute HTTP(S) URL`);
  }
  const optionIds = new Set();
  if (blocker.options !== undefined) {
    if (!positiveInt(blocker.revision) || !Array.isArray(blocker.options) || !blocker.options.length) {
      fail('INVALID_BLOCKER', `blocker ${blocker.id} alternatives need a positive revision and nonempty options`);
    }
    for (const id of validateUnique(blocker.options, `blocker ${blocker.id} option`)) optionIds.add(id);
    for (const option of blocker.options) {
      if (!nonempty(option.label) || !nonempty(option.impact)) fail('INVALID_BLOCKER', `blocker ${blocker.id} alternative needs label and impact`);
    }
  }
  if (blocker.revision !== undefined && !positiveInt(blocker.revision)) fail('INVALID_BLOCKER', `blocker ${blocker.id} revision must be positive`);
  if (blocker.recommendation != null && !nonempty(blocker.recommendation)) fail('INVALID_BLOCKER', `blocker ${blocker.id} recommendation must be nonempty text`);
  if (blocker.user_answer != null) {
    const answer = blocker.user_answer;
    if (!object(answer) || answer.revision !== blocker.revision || !nonempty(answer.source) ||
        (!nonempty(answer.option_id) && !nonempty(answer.text))) fail('STALE_ANSWER', `blocker ${blocker.id} alternative needs a source, value, and matching revision`);
    if (!optionIds.size || (answer.option_id != null && !optionIds.has(answer.option_id))) fail('INVALID_BLOCKER', `blocker ${blocker.id} alternative needs a recognized option or Other text`);
  }
}

function validateCard(card, requestIds) {
  validateInteraction(card);
  checkId(card.request_id, 'card request id');
  if (!requestIds.has(card.request_id)) fail('MISSING_REFERENCE', `card ${card.id} references missing request`);
  if (!positiveInt(card.revision) || !cardTypes.has(card.type) || !cardStatuses.has(card.status)) {
    fail('INVALID_CARD', `card ${card.id} needs a positive revision, valid type and status`);
  }
  for (const field of ['title', 'body', 'source']) {
    if (!nonempty(card[field])) fail('INVALID_CARD', `card ${card.id} needs ${field}`);
  }
  if (card.type === 'completion' && (!object(card.completion) || !positiveInt(card.completion.request_revision) ||
      Object.keys(card.completion).length !== 1)) fail('INVALID_CARD', `completion ${card.id} needs its Request event revision`);
  if (card.type !== 'completion' && Object.hasOwn(card, 'completion')) fail('INVALID_CARD', `card ${card.id} cannot claim a completion event`);
  if (card.type !== 'suggestion') {
    if (Object.hasOwn(card, 'options') || Object.hasOwn(card, 'user_answer')) {
      fail('INVALID_CARD', `${card.type} card ${card.id} cannot contain options or user_answer`);
    }
    return;
  }
  const optionIds = new Set();
  if (card.options !== undefined) {
    if (!Array.isArray(card.options) || !card.options.length) fail('INVALID_CARD', `card ${card.id} options must be a nonempty array`);
    for (const id of validateUnique(card.options, `card ${card.id} option`)) optionIds.add(id);
    for (const option of card.options) {
      if (!nonempty(option.label) || !nonempty(option.impact)) fail('INVALID_CARD', `card ${card.id} option needs label and impact`);
    }
  }
  if (card.recommendation != null && !nonempty(card.recommendation)) fail('INVALID_CARD', `card ${card.id} recommendation must be nonempty text`);
  const answer = card.user_answer;
  if (answer != null) {
    if (!object(answer) || answer.revision !== card.revision || !nonempty(answer.source) ||
        (!nonempty(answer.option_id) && !nonempty(answer.text))) {
      fail('STALE_ANSWER', `card ${card.id} answer needs a source, value, and matching revision`);
    }
    if (!optionIds.size || (answer.option_id != null && !optionIds.has(answer.option_id))) {
      fail('INVALID_CARD', `card ${card.id} answer needs a choice and a recognized option or Other text`);
    }
  }
  validateAnswerProvenance(card, optionIds, `suggestion ${card.id}`, 'INVALID_CARD');
  if (!['answered', 'dismissed', 'superseded'].includes(card.status) && answer) fail('INVALID_CARD', `card ${card.id} has an answer but is not answered`);
}

function targetKey(item) { return `${item.collection}:${item.id}`; }
function versionKey(item) { return `${targetKey(item)}:${item.record_revision}`; }
function isChoice(collection, record) {
  return (['decisions', 'blockers'].includes(collection) || (collection === 'cards' && record?.type === 'suggestion')) &&
    Array.isArray(record?.options) && record.options.length > 0;
}

function isUnanswered(collection, record) {
  return ['open', 'deferred'].includes(record?.status) && !record.user_answer &&
    (['decisions', 'blockers'].includes(collection) || (collection === 'cards' && record.type === 'suggestion'));
}

function actionAllowed(item, record) {
  return item.kind === 'acknowledge' ? item.collection !== 'requests' && record != null
    : item.kind === 'resolve' ? ['open', 'answered'].includes(record?.status) &&
      (item.collection === 'blockers' || (item.collection === 'cards' && ['qa', 'note', 'completion'].includes(record.type)))
    : item.kind === 'defer' && item.collection === 'blockers' ? record?.status === 'open'
    : isUnanswered(item.collection, record) && (item.kind !== 'answer' || isChoice(item.collection, record));
}

// A source reference records the agent's claim that it read a human message.
// The local validator cannot authenticate the message, its author, or transport.
function validateReplyMetadata(reply) {
  if (reply.input_method !== undefined && !['card', 'chat'].includes(reply.input_method)) {
    fail('INVALID_REPLY', `reply ${reply.id} input_method must be card or chat when supplied`);
  }
  if (reply.recorded_at !== undefined) {
    const value = reply.recorded_at;
    const date = typeof value === 'string' && /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)(?![\s\S])/.exec(value);
    if (!date || !Number.isFinite(Date.parse(value)) ||
        new Date(`${date[1]}T00:00:00Z`).toISOString().slice(0, 10) !== date[1]) {
      fail('INVALID_REPLY', `reply ${reply.id} recorded_at must be a valid ISO timestamp`);
    }
  }
}

function validateReply(reply, versions, commitRevision) {
  validateReplyMetadata(reply);
  if (!nonempty(reply.source) || !Array.isArray(reply.items) || !reply.items.length) {
    fail('INVALID_REPLY', `reply ${reply.id} needs an actual message source and nonempty items`);
  }
  const seen = new Set(), actions = new Set();
  for (const item of reply.items) {
    if (!object(item) || !replyTargets.includes(item.collection) || !positiveInt(item.record_revision) ||
        !['answer', 'comment', 'defer', 'acknowledge', 'resolve'].includes(item.kind)) fail('INVALID_REPLY', `reply ${reply.id} has an invalid item`);
    checkId(item.id, 'reply target id');
    const binding = `${versionKey(item)}:${item.kind}`;
    if (seen.has(binding)) fail('INVALID_REPLY', `reply ${reply.id} repeats an item binding`);
    seen.add(binding);
    if (item.kind !== 'comment') {
      if (actions.has(targetKey(item))) fail('INVALID_REPLY', `reply ${reply.id} repeats or conflicts with an action for one card`);
      actions.add(targetKey(item));
    }
    if (item.text !== undefined && !nonempty(item.text)) fail('INVALID_REPLY', `reply ${reply.id} item text must be nonblank`);
    if (item.option_id != null) checkId(item.option_id, 'reply option id');
    const target = versions.get(versionKey(item));
    if (!target || item.record_revision >= commitRevision) {
      fail('MISSING_REPLY_TARGET', `reply ${reply.id} references a version that was not previously committed`);
    }
    if (item.kind === 'comment') {
      if (!nonempty(item.text) || (item.outcome !== undefined && item.outcome !== 'accepted')) {
        fail('INVALID_REPLY', `reply ${reply.id} comment needs text and an accepted outcome`);
      }
    } else if (item.kind === 'answer') {
      if (!['accepted', 'stale'].includes(item.outcome) || !actionAllowed(item, target) ||
          (item.option_id == null ? !nonempty(item.text) : !target.options.some(option => option.id === item.option_id))) {
        fail('INVALID_REPLY', `reply ${reply.id} answer needs an outcome and a recognized original choice or Other text`);
      }
    } else if (!['accepted', 'stale'].includes(item.outcome) || !actionAllowed(item, target)) {
      fail('INVALID_REPLY', `reply ${reply.id} action needs an outcome and an eligible original card`);
    }
  }
}

function validateNewReplies(current, receipts) {
  const versions = new Map();
  const lastChanges = new Map();
  for (const entry of current.history) {
    for (const change of entry.changes) {
      if (!replyTargets.includes(change.collection)) continue;
      const item = { collection: change.collection, id: change.id, record_revision: entry.revision };
      versions.set(versionKey(item), change.after);
      if (actionVersionChanged(change.collection, change.before, change.after)) lastChanges.set(targetKey(item), entry.revision);
    }
  }
  for (const receipt of receipts ?? []) {
    const previous = current.replies.find(item => item.id === receipt.id);
    if (previous) {
      if (!isDeepStrictEqual(previous, receipt)) fail('IMMUTABLE_REPLY', `reply ${receipt.id} cannot be changed`);
      continue;
    }
    // Retired actions can be recorded as stale reports to reconcile old deliveries.
    // They cannot become accepted actions; historical accepted receipts stay intact.
    if (Array.isArray(receipt.items) && receipt.items.some(item => item?.collection === 'blockers' &&
        ['resolve', 'acknowledge'].includes(item.kind) && item.outcome !== 'stale')) {
      fail('INVALID_REPLY', `reply ${receipt.id} can only record retired Blocker resolve or acknowledge actions as stale reports`);
    }
    validateReply(receipt, versions, current.revision + 1);
    validateReceiptCurrent(receipt, current, lastChanges);
  }
  return lastChanges;
}

function validateReceiptCurrent(receipt, current, lastChanges, historicalRecordChanges) {
  for (const item of receipt.items) {
    if (item.kind === 'comment') continue;
    const target = current[item.collection].find(record => record.id === item.id);
    const currentChoice = item.record_revision >= lastChanges.get(targetKey(item)) && actionAllowed(item, target);
    if (item.outcome === 'accepted' && !currentChoice) {
      fail('STALE_REPLY', `reply ${receipt.id} action is no longer bound to the current eligible card`);
    }
    // The 0.5.2 writer classified every record delta as action-changing.
    // Replay may retain its conservative stale outcome after auxiliary Decision
    // links changed; this never upgrades the receipt to accepted authority.
    // Retired Blocker actions are stale reports even when their target is unchanged.
    const legacyStale = (item.collection === 'blockers' && ['resolve', 'acknowledge'].includes(item.kind)) ||
      (item.collection === 'decisions' && historicalRecordChanges && historicalRecordChanges.get(targetKey(item)) > item.record_revision);
    if (item.outcome === 'stale' && currentChoice && !legacyStale) {
      fail('INVALID_REPLY_OUTCOME', `reply ${receipt.id} cannot mark a current eligible action stale`);
    }
  }
}

function validateReplyAnswerBindings(current, next, upsert, lastChanges) {
  for (const collection of ['decisions', 'blockers', 'cards']) {
    for (const patch of upsert[collection] ?? []) {
      if (!Object.hasOwn(patch, 'user_answer') || !object(patch.user_answer)) continue;
      const previous = current[collection].find(record => record.id === patch.id);
      const record = next[collection].find(record => record.id === patch.id);
      const answer = record.user_answer;
      if (isDeepStrictEqual(previous?.user_answer, answer)) continue;
      const receipts = [...current.replies, ...(upsert.replies ?? [])].filter(receipt => receipt.source === answer.source);
      // Directly referenced human answers without an atomic receipt retain the
      // existing validation path. A receipt source cannot justify another value.
      if (!receipts.length) continue;
      const matching = isUnanswered(collection, previous) && isChoice(collection, previous) &&
        previous.revision === record.revision && receipts.some(receipt => receipt.items.some(item =>
          item.collection === collection && item.id === patch.id &&
          (item.outcome === 'accepted' || (item.kind === 'comment' && item.outcome == null)) &&
          item.record_revision >= lastChanges.get(targetKey(item)) &&
          (item.kind === 'answer' ? (item.option_id ?? null) === (answer.option_id ?? null) && (item.text ?? null) === (answer.text ?? null)
            : item.kind === 'comment' && answer.option_id == null && item.text === answer.text)));
      if (!matching) fail('REPLY_ANSWER_MISMATCH', `${collection} ${patch.id} answer does not match an accepted receipt for its unchanged choice`);
    }
  }
}

function matchingReceiptItems(current, upsert, source, collection, id, lastChanges) {
  const receipts = [...current.replies, ...(upsert.replies ?? [])].filter(receipt => receipt.source === source);
  const matching = receipts.flatMap(receipt => receipt.items).filter(item => item.collection === collection && item.id === id &&
    (item.outcome === 'accepted' || (item.kind === 'comment' && item.outcome == null)) && item.record_revision >= lastChanges.get(targetKey(item)));
  return { receipts, matching };
}

function unchangedInteraction(before, after) {
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...fields].filter(field => !['attention', 'nudge', 'urls', 'last_changed_turn'].includes(field))
    .every(field => isDeepStrictEqual(before?.[field], after?.[field]));
}

function materialAttentionChange(collection, before, after) {
  if (!before) return false;
  return collection === 'blockers'
    ? ['title', 'body', 'evidence', 'next_action', 'owner', 'request_id', 'options', 'recommendation'].some(field => !isDeepStrictEqual(before[field], after[field]))
    : ['decisions', 'cards'].includes(collection) && after.revision !== before.revision;
}

// Destination changes are part of the current blocker condition. Keep the
// older history freshness rule above unchanged so legacy receipts still load.
function blockerConditionChanged(before, after) {
  return before != null && (materialAttentionChange('blockers', before, after) ||
    ['action_url', 'action_label'].some(field => !isDeepStrictEqual(before[field], after[field])));
}

function validateAttentionFreshness(collection, before, after) {
  const inferredClosure = before && !after.user_answer && before.status !== after.status && !['open', 'deferred'].includes(after.status);
  if (after.attention?.state === 'acknowledged' && isDeepStrictEqual(before?.attention, after.attention) &&
      (materialAttentionChange(collection, before, after) || inferredClosure)) {
    fail('STALE_ATTENTION', `${collection} ${after.id} cannot reuse acknowledgment for changed content or inferred closure`);
  }
}

function validateReplyInteractionBindings(current, next, upsert, lastChanges) {
  for (const collection of ['decisions', 'blockers', 'cards']) {
    for (const patch of upsert[collection] ?? []) {
      const before = current[collection].find(record => record.id === patch.id);
      const after = next[collection].find(record => record.id === patch.id);
      const attention = after.attention;
      if (Object.hasOwn(patch, 'attention') && object(attention) && attention.actor === 'user' && !isDeepStrictEqual(before?.attention, attention)) {
        const { receipts, matching } = matchingReceiptItems(current, upsert, attention.source, collection, patch.id, lastChanges);
        const later = attention.state === 'later';
        const ack = attention.state === 'acknowledged';
        const matchingAction = matching.some(item => later ? ['defer', 'comment'].includes(item.kind)
          : ack ? ['answer', 'acknowledge', 'comment'].includes(item.kind) ||
            (item.kind === 'resolve' && collection === 'cards' && ['qa', 'note', 'completion'].includes(after.type)) : true);
        const onlyAck = ack && !matching.some(item => ['answer', 'comment', 'resolve'].includes(item.kind));
        if ((receipts.length && !matchingAction) || (before && (later || (receipts.length && onlyAck)) && !unchangedInteraction(before, after))) {
          fail('REPLY_ATTENTION_MISMATCH', `${collection} ${patch.id} attention does not match an accepted current action or changes semantic work`);
        }
      }
      const resolution = after.resolution;
      if (Object.hasOwn(patch, 'resolution') && object(resolution) && resolution.actor === 'user' && !isDeepStrictEqual(before?.resolution, resolution)) {
        const { receipts, matching } = matchingReceiptItems(current, upsert, resolution.source, collection, patch.id, lastChanges);
        if (receipts.length && !matching.some(item => item.kind === 'comment' ||
            (item.kind === 'resolve' && collection === 'cards' && ['qa', 'note', 'completion'].includes(after.type)) || (item.kind === 'answer' &&
            (item.option_id ?? null) === (resolution.option_id ?? null) && (item.text ?? null) === (resolution.text ?? null)))) {
          fail('REPLY_RESOLUTION_MISMATCH', `${collection} ${patch.id} resolution does not match an accepted current reply; acknowledgment cannot resolve work`);
        }
      }
    }
  }
}

function knownHumanSource(current, upsert, source) {
  if ([...current.replies, ...(upsert.replies ?? [])].some(reply => reply.source === source)) return true;
  const collections = ['decisions', 'blockers', 'cards'];
  const records = [
    ...collections.flatMap(collection => [...current[collection], ...(upsert[collection] ?? [])]),
    // Replaced user-attributed outcomes remain human provenance in history.
    ...current.history.flatMap(event => event.changes.filter(change => collections.includes(change.collection))
      .flatMap(change => [change.before, change.after])),
  ];
  return records.some(record => record?.user_answer?.source === source ||
    (record?.attention?.actor === 'user' && record.attention.source === source) ||
    (record?.resolution?.actor === 'user' && record.resolution.source === source) ||
    (record?.dismissal?.actor === 'user' && record.dismissal.source === source));
}

// New writes require evidence for lifecycle outcomes. Historical version-1
// closures remain readable, even when their old writer did not store provenance.
function validateLifecycleUpdate(current, next, upsert, lastChanges) {
  for (const collection of ['decisions', 'blockers', 'cards']) {
    for (const patch of upsert[collection] ?? []) {
      const before = current[collection].find(record => record.id === patch.id);
      const after = next[collection].find(record => record.id === patch.id);
      validateInteraction(after);
      if (collection === 'blockers' && after.status === 'open' && after.attention?.state === 'acknowledged' &&
          (before?.status !== 'open' || !isDeepStrictEqual(before.attention, after.attention))) {
        fail('BLOCKER_VERIFICATION_REQUIRED', `blocker ${patch.id} cannot be hidden by acknowledgment; verify the obstacle or explicitly choose Later`);
      }
      const terminal = ['resolved', 'superseded', 'dismissed'].includes(after.status) ||
        (after.status === 'answered' && !['qa', 'note', 'completion'].includes(after.type));
      const wasLater = before?.attention?.state === 'later' ||
        (before?.status === 'deferred' && before.attention?.state !== 'pending');
      if (wasLater && !terminal && after.attention?.state !== 'later' &&
          !(Object.hasOwn(patch, 'attention') && after.attention?.state === 'pending' &&
            nonempty(after.attention.source) && nonempty(after.attention.reason))) {
        fail('REOPEN_REASON_REQUIRED', `${collection} ${patch.id} Later needs an explicit pending state, source, and concrete dependency reason to reopen`);
      }
      if (before?.status === 'dismissed' && !terminal &&
          !(Object.hasOwn(patch, 'attention') && after.attention?.state === 'pending' && nonempty(after.attention.reason))) {
        fail('REOPEN_REASON_REQUIRED', `${collection} ${patch.id} dismissal needs a sourced pending reopening reason`);
      }
      const acknowledgmentCard = collection === 'cards' && ['qa', 'note', 'completion'].includes(after.type);
      const changedContent = materialAttentionChange(collection, before, after);
      if (after.status !== 'resolved' || (before?.status === 'resolved' && (collection === 'blockers'
          ? isDeepStrictEqual(before.resolution, after.resolution) && !blockerConditionChanged(before, after)
          : !acknowledgmentCard || !changedContent))) continue;
      const resolution = after.resolution;
      if (collection === 'blockers') {
        const reportSource = knownHumanSource(current, upsert, resolution?.source);
        if (resolution?.actor !== 'agent' || !nonempty(resolution.source) || !nonempty(resolution.note) || reportSource) {
          fail('BLOCKER_VERIFICATION_REQUIRED', `blocker ${patch.id} needs independently sourced agent verification; a known human reply cannot verify the obstacle`);
        }
        const verifiedRevision = [...current.history].reverse().find(event =>
          event.changes.some(change => change.collection === collection && change.id === patch.id))?.revision;
        if (before && (resolution.record_revision !== verifiedRevision || after.revision !== before.revision ||
            blockerConditionChanged(before, after))) {
          fail('STALE_VERIFICATION', `blocker ${patch.id} verification must bind its current record revision ${verifiedRevision}`);
        }
      } else if (acknowledgmentCard) {
        if (resolution?.actor !== 'user' || !nonempty(resolution.source) || !nonempty(resolution.note)) {
          fail('ACKNOWLEDGMENT_REQUIRED', `${after.type} ${patch.id} resolution needs attributable human acknowledgment`);
        }
        if (before?.resolution?.source === resolution.source) {
          fail('STALE_ACKNOWLEDGMENT', `${after.type} ${patch.id} changed or reopened content needs a fresh human acknowledgment`);
        }
        const { receipts, matching } = matchingReceiptItems(current, upsert, resolution.source, collection, patch.id, lastChanges);
        // A received action describes a previously saved card, never new content
        // introduced in the same write. Directly cited human messages retain
        // their existing provenance path; old receipt/history entries stay intact.
        if (receipts.length && (changedContent || !matching.some(item => ['comment', 'resolve'].includes(item.kind)))) {
          fail('REPLY_RESOLUTION_MISMATCH', `${after.type} ${patch.id} resolution needs an accepted reply for its unchanged current content`);
        }
      }
    }
  }
}

function validateTurn(turn, requestIds) {
  if (turn === null) return;
  if (!object(turn)) fail('INVALID_TURN', 'turn must be an object or null');
  checkId(turn.id, 'turn id');
  if (!nonempty(turn.source) || !nonempty(turn.summary) || !endReasons.has(turn.end_reason)) {
    fail('INVALID_TURN', 'turn needs source, summary, and valid end_reason');
  }
  const run = turn.continuing_run;
  if (run != null) {
    if (!object(run) || !nonempty(run.id) || !nonempty(run.status)) fail('INVALID_TURN', 'continuing_run needs id and status');
    if (run.request_ids != null) {
      if (!Array.isArray(run.request_ids)) fail('INVALID_TURN', 'continuing_run request_ids must be an array');
      const seen = new Set();
      for (const id of run.request_ids) {
        checkId(id, 'continuing run request id');
        if (seen.has(id)) fail('INVALID_TURN', 'continuing_run request_ids must be unique');
        if (requestIds && !requestIds.has(id)) fail('MISSING_REFERENCE', `continuing run references missing request ${id}`);
        seen.add(id);
      }
    }
    if (run.observed_turn_id != null) checkId(run.observed_turn_id, 'continuing run observation turn id');
    if (run.evidence != null && !hasEvidence(run.evidence)) fail('INVALID_TURN', 'continuing_run evidence must be a reference or nonempty reference list');
  }
}

export function validateJournal(state) {
  if (!object(state) || state.schema_version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0) {
    fail('INVALID_STATE', 'journal needs schema_version 1 and nonnegative revision');
  }
  checkId(state.conversation_id, 'conversation id');
  for (const key of ['requests', 'decisions', 'blockers', 'history']) {
    if (!Array.isArray(state[key])) fail('INVALID_STATE', `${key} must be an array`);
  }
  for (const key of ['cards', 'replies']) {
    if (Object.hasOwn(state, key) && !Array.isArray(state[key])) fail('INVALID_STATE', `${key} must be an array when present`);
  }
  const requestIds = validateUnique(state.requests, 'request');
  validateUnique(state.decisions, 'decision');
  validateUnique(state.blockers, 'blocker');
  validateUnique(state.cards ?? [], 'card');
  validateUnique(state.replies ?? [], 'reply');
  const parents = new Map();
  for (const request of state.requests) {
    validateRequest(request);
    if (request.parent_id != null && !requestIds.has(request.parent_id)) {
      fail('MISSING_REFERENCE', `request ${request.id} references missing parent`);
    }
    parents.set(request.id, request.parent_id ?? null);
  }
  for (const id of requestIds) {
    const seen = new Set();
    let current = id;
    while (current !== null) {
      if (seen.has(current)) fail('PARENT_CYCLE', `request parent cycle includes ${current}`);
      seen.add(current);
      current = parents.get(current) ?? null;
    }
  }
  const byId = new Map(state.requests.map(request => [request.id, request]));
  for (const request of state.requests) {
    if (!['active', 'waiting', 'deferred'].includes(request.status)) continue;
    let child = request;
    while (child.parent_id != null) {
      if (nonempty(child.scope_exclusion_source)) break;
      const parent = byId.get(child.parent_id);
      if (parent.status === 'done') fail('UNFINISHED_CHILD', `done request ${parent.id} still includes unfinished child ${request.id}`);
      child = parent;
    }
  }
  for (const decision of state.decisions) validateDecision(decision, requestIds);
  for (const blocker of state.blockers) validateBlocker(blocker, requestIds);
  for (const card of state.cards ?? []) validateCard(card, requestIds);
  for (const collection of ['decisions', 'blockers', 'cards']) {
    for (const record of state[collection] ?? []) {
      const replacement = record.dismissal?.replacement;
      if (replacement && ((replacement.collection === collection && replacement.id === record.id) ||
          !(state[replacement.collection] ?? []).some(candidate => candidate.id === replacement.id))) {
        fail('INVALID_DISMISSAL', `${record.id} dismissal replacement must reference another saved card`);
      }
    }
  }
  validateTurn(state.turn, requestIds);
  validateHistory(state);
  validateCompletionOrigins(state);
  return state;
}

function completionEvent(before, after) {
  return after.status === 'done' && (!before || before.status !== 'done' ||
    requestOutcomeFields.some(field => !isDeepStrictEqual(before[field], after[field])));
}
function completionSnapshot(request, revision, source) {
  return { id: `completion-${createHash('sha256').update(`${request.id}:${revision}`).digest('hex').slice(0, 24)}`,
    request_id: request.id, revision: 1, type: 'completion', title: request.title,
    body: Array.isArray(request.evidence) ? request.evidence.map(value => `- ${value}`).join('\n') : request.evidence,
    source, status: 'open', completion: { request_revision: revision },
    ...(Object.hasOwn(request, 'urls') ? { urls: structuredClone(request.urls) } : {}) };
}
function validateCompletionOrigins(state) {
  for (const card of state.cards ?? []) if (card.type === 'completion') {
    const event = state.history[card.completion.request_revision - 1];
    const request = event?.changes.find(change => change.collection === 'requests' && change.id === card.request_id);
    const creation = event?.changes.find(change => change.collection === 'cards' && change.id === card.id);
    const source = event?.changes.find(change => change.collection === 'turn')?.after.source;
    if (!request || !completionEvent(request.before, request.after) || !creation || creation.before !== null || !source) {
      fail('INVALID_COMPLETION_EVENT', `completion ${card.id} must bind its committed Request completion event`);
    }
    const expected = completionSnapshot(request.after, event.revision, source);
    if (!isDeepStrictEqual(creation.after, expected) || Object.keys(expected).some(field =>
      !completionLifecycleFields.has(field) && !isDeepStrictEqual(card[field], expected[field]))) {
      fail('INVALID_COMPLETION_EVENT', `completion ${card.id} must preserve its original result snapshot`);
    }
  }
}

// History is a sequence of record deltas, not full-state snapshots. Replay
// checks internal consistency only; it cannot authenticate sources or effects.
function validateHistory(state) {
  if (state.history.length !== state.revision) fail('INVALID_HISTORY', 'one history entry is required per committed revision');
  const replay = Object.fromEntries(collections.map(key => [key, new Map()]));
  const versions = new Map();
  const lastChanges = new Map();
  const recordChanges = new Map();
  let lastTurn = null;
  const closedTurns = new Set();
  for (const [index, entry] of state.history.entries()) {
    if (!object(entry) || entry.revision !== index + 1 || !nonempty(entry.turn_id) || !Array.isArray(entry.changes)) {
      fail('INVALID_HISTORY', 'history revisions must be contiguous and include turn_id and changes');
    }
    const previous = Object.fromEntries(collections.map(key => [key, [...replay[key].values()]]));
    const previousLastChanges = new Map(lastChanges);
    const previousRecordChanges = new Map(recordChanges);
    const upsert = Object.fromEntries(collections.map(key => [key, entry.changes.filter(change => change.collection === key).map(change => change.after)]));
    const entryRequestIds = new Set([...replay.requests.keys(), ...(upsert.requests ?? []).map(request => request.id)]);
    const seen = new Set();
    for (const change of entry.changes) {
      if (!object(change) || ![...collections, 'turn'].includes(change.collection) ||
          !object(change.after) || change.id !== change.after.id || seen.has(`${change.collection}:${change.id}`)) {
        fail('INVALID_HISTORY', 'history needs unique, non-deleting record changes');
      }
      seen.add(`${change.collection}:${change.id}`);
      const before = change.collection === 'turn' ? lastTurn : replay[change.collection].get(change.id) ?? null;
      if (!isDeepStrictEqual(change.before, before)) fail('INVALID_HISTORY', 'history before-value does not match the preceding commit');
      if (change.collection === 'turn') {
        if (change.id !== entry.turn_id) fail('INVALID_HISTORY', 'history turn change must match turn_id');
        validateTurn(change.after);
        if (lastTurn?.id !== change.id) {
          if (closedTurns.has(change.id)) fail('INVALID_HISTORY', 'a superseded turn cannot reappear');
          if (lastTurn) closedTurns.add(lastTurn.id);
        }
        lastTurn = change.after;
      } else {
        if (['decisions', 'blockers', 'cards'].includes(change.collection)) validateAttentionFreshness(change.collection, before, change.after);
        if (change.collection === 'requests') { validateWorkspace(change.after); validateUrls(change.after); }
        if (change.collection === 'decisions') { validateDecision(change.after, entryRequestIds); validateChoiceRevision('decisions', before, change.after); }
        if (change.collection === 'blockers') {
          validateBlocker(change.after, entryRequestIds);
          if (before?.revision !== undefined || change.after.options !== undefined) validateChoiceRevision('blockers', before, change.after);
        }
        if (change.collection === 'cards') {
          validateCard(change.after, new Set([...replay.requests.keys(), ...entry.changes.filter(item => item.collection === 'requests').map(item => item.id)]));
          validateChoiceRevision('cards', before, change.after);
        }
        if (change.collection === 'replies') {
          if (before && !isDeepStrictEqual(before, change.after)) fail('IMMUTABLE_REPLY', `reply ${change.id} cannot change in history`);
          validateReply(change.after, versions, entry.revision);
          if (!before) validateReceiptCurrent(change.after, previous, previousLastChanges, previousRecordChanges);
        }
        replay[change.collection].set(change.id, change.after);
        if (replyTargets.includes(change.collection)) {
          versions.set(versionKey({ collection: change.collection, id: change.id, record_revision: entry.revision }), change.after);
          recordChanges.set(targetKey(change), entry.revision);
          if (actionVersionChanged(change.collection, change.before, change.after)) lastChanges.set(targetKey(change), entry.revision);
        }
      }
    }
    const current = Object.fromEntries(collections.map(key => [key, [...replay[key].values()]]));
    validateReplyAnswerBindings(previous, current, upsert, previousLastChanges);
    validateReplyInteractionBindings(previous, current, upsert, previousLastChanges);
    if (!seen.has(`turn:${entry.turn_id}`)) fail('INVALID_HISTORY', 'every commit needs a turn checkpoint');
  }
  if (!isDeepStrictEqual(lastTurn, state.turn) ||
      collections.some(key => !isDeepStrictEqual([...replay[key].values()], state[key] ?? []))) {
    fail('INVALID_HISTORY', 'saved snapshot does not match its committed history');
  }
}

export async function readJournal(dataDir, conversationId) {
  const file = statePath(dataDir, conversationId);
  try {
    // Never follow a journal-file symlink. The containing data directory is
    // caller-authorized and trusted; this is not a hostile-filesystem sandbox.
    if (!(await fs.lstat(file)).isFile()) fail('UNSAFE_PATH', 'journal path must be a regular file, not a symlink');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let text;
    try {
      if (!(await handle.stat()).isFile()) fail('UNSAFE_PATH', 'journal path must be a regular file');
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    const state = { cards: [], replies: [], ...JSON.parse(text) };
    validateJournal(state);
    if (state.conversation_id !== conversationId) fail('INVALID_STATE', 'journal conversation id does not match filename');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState(conversationId);
    if (error.code === 'ELOOP') fail('UNSAFE_PATH', 'journal path must not be a symlink');
    if (error instanceof SyntaxError) fail('INVALID_JSON', `journal ${conversationId} contains invalid JSON`);
    throw error;
  }
}

function checkUpdateShape(update) {
  if (!object(update) || !Number.isSafeInteger(update.expected_revision) || update.expected_revision < 0) {
    fail('INVALID_UPDATE', 'update needs nonnegative expected_revision');
  }
  for (const key of Object.keys(update)) {
    if (!['expected_revision', 'turn', 'upsert'].includes(key)) fail('INVALID_UPDATE', `unknown update field: ${key}`);
  }
  validateTurn(update.turn);
  if (!update.turn) fail('INVALID_UPDATE', 'update needs a turn checkpoint');
  if (!object(update.upsert)) fail('INVALID_UPDATE', 'update needs upsert object');
  for (const key of Object.keys(update.upsert)) {
    if (!collections.includes(key)) fail('INVALID_UPDATE', `unknown upsert collection: ${key}`);
    if (!Array.isArray(update.upsert[key])) fail('INVALID_UPDATE', `upsert ${key} must be an array`);
    validateUnique(update.upsert[key], `upsert ${key}`);
  }
}

function validateChoiceRevision(collection, previous, patch) {
  if (!previous) return;
  const bookkeeping = collection === 'decisions' ? decisionBookkeeping : cardBookkeeping;
  const code = { decisions: 'DECISION_REVISION_REQUIRED', blockers: 'BLOCKER_REVISION_REQUIRED', cards: 'CARD_REVISION_REQUIRED' }[collection];
  if (collection === 'blockers' && previous.revision === undefined) {
    if (patch.revision !== undefined && patch.revision !== 1) fail(code, `blockers ${patch.id} first choice revision must be one`);
    return;
  }
  const material = Object.keys(patch).some(field =>
    !bookkeeping.has(field) && !isDeepStrictEqual(patch[field], previous[field]));
  if (material && (patch.revision === undefined || patch.revision === previous.revision)) {
    fail(code, `${collection} ${patch.id} changed materially without a new revision`);
  }
  if (patch.revision !== undefined && patch.revision !== previous.revision && patch.revision !== previous.revision + 1) {
    fail(code, `${collection} ${patch.id} revision must advance by one`);
  }
}

function upsertCollection(state, collection, patches, changes) {
  for (const patch of patches ?? []) {
    const index = state[collection].findIndex(item => item.id === patch.id);
    const previous = index < 0 ? null : state[collection][index];
    if (['decisions', 'cards'].includes(collection) || (collection === 'blockers' && (previous?.revision !== undefined || patch.options !== undefined))) {
      validateChoiceRevision(collection, previous, patch);
    }
    const next = { ...(previous ?? {}), ...patch };
    if (collection === 'requests' && previous && next.parent_id !== previous.parent_id &&
        !Object.hasOwn(patch, 'scope_exclusion_source')) {
      next.scope_exclusion_source = null;
    }
    if (['decisions', 'blockers', 'cards'].includes(collection) && previous && next.revision > previous.revision) {
      if (!Object.hasOwn(patch, 'user_answer') && (['decisions', 'blockers'].includes(collection) || next.type === 'suggestion')) next.user_answer = null;
      if (!Object.hasOwn(patch, 'resolution')) next.resolution = null;
      if (next.attention != null && next.attention.state !== 'later' && (!Object.hasOwn(patch, 'attention') || isDeepStrictEqual(next.attention, previous.attention))) next.attention = null;
      if (!Object.hasOwn(patch, 'status')) next.status = 'open';
    }
    const materialBlocker = collection === 'blockers' && blockerConditionChanged(previous, next);
    if (materialBlocker) {
      const inheritedVerification = !Object.hasOwn(patch, 'resolution') || isDeepStrictEqual(next.resolution, previous.resolution);
      if (inheritedVerification) {
        next.resolution = null;
        if (previous.status === 'resolved' && next.status === 'resolved') next.status = 'open';
      }
      if (next.attention?.state === 'acknowledged' && isDeepStrictEqual(next.attention, previous.attention)) next.attention = null;
    }
    if (collection !== 'requests' && collection !== 'replies' &&
        (!Object.hasOwn(patch, 'attention') || isDeepStrictEqual(next.attention, previous?.attention))) {
      const actualAnswer = object(patch.user_answer) && !isDeepStrictEqual(previous?.user_answer, patch.user_answer);
      const inferredClosure = !next.user_answer && previous?.status !== next.status && !['open', 'deferred'].includes(next.status);
      if (next.attention != null && ((actualAnswer && collection !== 'blockers') || (inferredClosure && next.attention.state === 'acknowledged'))) next.attention = null;
    }
    if (collection === 'requests' && previous && next.status === 'done' &&
        (previous.status !== 'done' || requestOutcomeFields.some(field => !isDeepStrictEqual(previous[field], next[field]))) &&
        !hasEvidence(patch.evidence)) {
      fail('MISSING_EVIDENCE', `request ${patch.id} needs explicitly supplied evidence for its current outcome`);
    }
    if (isDeepStrictEqual(previous, next)) continue;
    if (index < 0) state[collection].push(next);
    else state[collection][index] = next;
    changes.push({ collection, id: patch.id, before: previous, after: next });
  }
}

function validateCompletionPatches(current, patches) {
  for (const patch of patches ?? []) {
    const before = current.cards.find(card => card.id === patch.id);
    if (before?.type !== 'completion' && patch.type !== 'completion' && patch.completion == null) continue;
    if (before?.type !== 'completion' || Object.keys(patch).some(field => !completionLifecycleFields.has(field) &&
      !isDeepStrictEqual(patch[field], before[field]))) {
      fail('GENERATED_COMPLETION_IMMUTABLE', `completion ${patch.id} identity and content are generated from its Request event`);
    }
  }
}
function validateOutstandingCompletions(state, patches) {
  const pendingIds = new Set((patches ?? []).filter(patch => patch.attention?.state === 'pending').map(patch => patch.id));
  for (const card of state.cards.filter(card => card.type === 'completion')) {
    const historical = ['resolved', 'superseded', 'dismissed'].includes(card.status) ||
      (card.attention?.state === 'acknowledged' && card.attention.actor === 'user');
    if (historical && !pendingIds.has(card.id)) continue;
    const request = state.requests.find(record => record.id === card.request_id);
    const latest = [...state.history].reverse().find(event => event.changes.some(change =>
      change.collection === 'requests' && change.id === card.request_id && completionEvent(change.before, change.after)));
    if (request?.status !== 'done' || latest?.revision !== card.completion.request_revision) {
      fail('RETIRED_COMPLETION_EVENT', `completion ${card.id} cannot reopen an earlier or no longer completed Request result`);
    }
  }
}
function validateRequestCompletion(state, request) {
  const byId = new Map(state.requests.map(record => [record.id, record]));
  const scoped = new Set([request.id]);
  for (const record of state.requests) {
    if (['cancelled', 'proposed', 'deferred'].includes(record.status)) continue;
    let child = record; const seen = new Set();
    while (child?.parent_id != null && !nonempty(child.scope_exclusion_source) && !seen.has(child.id)) {
      if (child.parent_id === request.id) { scoped.add(record.id); break; }
      seen.add(child.id); child = byId.get(child.parent_id);
    }
  }
  const decision = state.decisions.find(record => scoped.has(record.request_id) && record.required !== false && unresolvedDecision(state, record));
  if (decision) fail('UNRESOLVED_DECISION', `done request ${request.id} still lacks required choice ${decision.id}`);
  const blocker = state.blockers.find(record => scoped.has(record.request_id) && record.status === 'open');
  if (blocker) fail('UNRESOLVED_BLOCKER', `done request ${request.id} still has unresolved blocker ${blocker.id}`);
}
function syncCompletionCards(next, changes, source) {
  const apply = patch => {
    const previousChange = changes.find(change => change.collection === 'cards' && change.id === patch.id);
    const generatedChanges = []; upsertCollection(next, 'cards', [patch], generatedChanges);
    if (previousChange && generatedChanges.length) previousChange.after = generatedChanges[0].after;
    else changes.push(...generatedChanges);
  };
  for (const change of changes.filter(change => change.collection === 'requests')) {
    const event = completionEvent(change.before, change.after);
    const reopened = change.before?.status === 'done' && change.after.status !== 'done';
    if (!event && !reopened) continue;
    if (event) validateRequestCompletion(next, change.after);
    for (const card of next.cards.filter(card => card.type === 'completion' && card.request_id === change.id &&
      !['resolved', 'superseded', 'dismissed'].includes(card.status) && card.attention?.state !== 'acknowledged')) {
      apply({ id: card.id, status: 'superseded', resolution: { actor: 'agent', source,
        note: reopened ? 'The Request is no longer complete.' : 'A newer completion result replaces this notification.' } });
    }
    if (event) {
      const card = completionSnapshot(change.after, next.revision + 1, source);
      if (next.cards.some(record => record.id === card.id)) fail('GENERATED_COMPLETION_IMMUTABLE', `completion identity ${card.id} is already occupied`);
      apply(card);
    }
  }
}

export async function updateJournal(dataDir, conversationId, update, options = {}) {
  statePath(dataDir, conversationId);
  update = snapshotUpdate(update);
  checkUpdateShape(update);
  return commitJournal(dataDir, conversationId, current => {
    if (current.revision !== update.expected_revision) {
      fail('STALE_REVISION', `expected revision ${update.expected_revision}; current revision is ${current.revision}`);
    }
    if (current.turn?.id !== update.turn.id && current.history.some(entry => entry.turn_id === update.turn.id)) {
      fail('STALE_TURN', `turn ${update.turn.id} was superseded by ${current.turn?.id}`);
    }
    if (options.stampReplyRecordedAt && update.upsert.replies) {
      const recorded_at = new Date().toISOString();
      update.upsert.replies = update.upsert.replies.map(receipt => {
        validateReplyMetadata(receipt);
        const previous = current.replies.find(reply => reply.id === receipt.id);
        // Original unstamped payloads can retry without changing the saved receipt.
        // Legacy receipts keep their missing timestamp; declared changes still fail.
        if (previous) return receipt.recorded_at === undefined && previous.recorded_at !== undefined
          ? { ...receipt, recorded_at: previous.recorded_at } : receipt;
        return { ...receipt, recorded_at };
      });
    }
    const next = structuredClone(current);
    validateCompletionPatches(current, update.upsert.cards);
    const lastChanges = validateNewReplies(current, update.upsert.replies);
    const changes = [];
    for (const collection of collections) {
      upsertCollection(next, collection, update.upsert[collection], changes);
    }
    syncCompletionCards(next, changes, update.turn.source);
    validateLifecycleUpdate(current, next, update.upsert, lastChanges);
    validateReplyAnswerBindings(current, next, update.upsert, lastChanges);
    validateReplyInteractionBindings(current, next, update.upsert, lastChanges);
    changes.push({ collection: 'turn', id: update.turn.id, before: next.turn, after: update.turn });
    next.turn = update.turn;
    next.revision++;
    next.history.push({ revision: next.revision, turn_id: update.turn.id, changes });
    validateOutstandingCompletions(next, update.upsert.cards);
    return next;
  });
}

export async function markCardRead(dataDir, conversationId, read) {
  read = snapshotUpdate(read);
  if (!object(read) || Object.keys(read).some(key => !['card_id', 'record_revision'].includes(key)) ||
      !positiveInt(read.record_revision)) fail('INVALID_MARK_READ', 'read needs only card_id and a positive record_revision');
  checkId(read.card_id, 'card id');
  return commitJournal(dataDir, conversationId, current => {
    const card = current.cards.find(record => record.id === read.card_id);
    if (!card || !['qa', 'note', 'completion'].includes(card.type)) fail('INVALID_READ_CARD', 'only Q&A, Note and Complete cards can be marked as read');
    const event = [...current.history].reverse().find(entry => entry.changes.some(change =>
      change.collection === 'cards' && change.id === card.id && actionVersionChanged('cards', change.before, change.after)));
    const meaningful = record => record == null ? record : Object.fromEntries(Object.entries(record).filter(([key]) =>
      !['urls', 'nudge', 'last_changed_turn'].includes(key)));
    const readEvent = [...current.history].reverse().find(entry => entry.changes.some(change =>
      change.collection === 'cards' && change.id === card.id && !isDeepStrictEqual(meaningful(change.before), meaningful(change.after))));
    const change = readEvent?.changes.find(change => change.collection === 'cards' && change.id === card.id);
    const bound = current.history[read.record_revision - 1]?.changes.find(change => change.collection === 'cards' && change.id === card.id);
    const resolution = { actor: 'user', source: `app:journal_mark_read:${card.id}:${read.record_revision}`,
      note: 'Marked as read in Request Tracker.', record_revision: read.record_revision };
    const acknowledged = change?.before && { ...change.before, status: 'resolved', resolution };
    if (acknowledged?.attention?.state === 'acknowledged') acknowledged.attention = null;
    // Cosmetic presentation edits retain the original read. Its latest
    // meaningful change must still bind the exact originally viewed snapshot.
    if (card.status === 'resolved' && isDeepStrictEqual(card.resolution, resolution) &&
        bound && isDeepStrictEqual(change?.before, bound.after) &&
        isDeepStrictEqual(meaningful(card), meaningful(acknowledged))) return current;
    if (event?.revision !== read.record_revision) fail('STALE_RECORD', 'the card changed; review its current version before marking it as read');
    if (!['open', 'answered'].includes(card.status)) fail('INVALID_READ_CARD', 'this card is no longer eligible to be marked as read');
    const next = structuredClone(current), changes = [];
    const patch = { id: card.id, status: 'resolved', resolution };
    upsertCollection(next, 'cards', [patch], changes);
    validateLifecycleUpdate(current, next, { cards: [patch] }, new Map());
    changes.push({ collection: 'turn', id: current.turn.id, before: current.turn, after: current.turn });
    next.revision++;
    next.history.push({ revision: next.revision, turn_id: current.turn.id, changes });
    return next;
  });
}

async function commitJournal(dataDir, conversationId, operation) {
  const file = statePath(dataDir, conversationId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockFile = `${file}.lock`;
  let lock;
  try {
    lock = await fs.open(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') fail('LOCKED', `journal ${conversationId} is locked by another writer`);
    throw error;
  }
  let tempFile;
  let operationError;
  try {
    const current = await readJournal(dataDir, conversationId);
    const next = operation(current);
    if (next === current) return current;
    validateJournal(next);
    tempFile = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(tempFile, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempFile, file);
    tempFile = undefined;
    return next;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    // A cleanup failure must not strand the owned lock, mask the primary
    // failure, or cause us to remove another writer's pre-existing lock.
    const errors = [];
    if (tempFile) { try { await fs.rm(tempFile, { force: true }); } catch (error) { errors.push(error); } }
    try { await lock.close(); } catch (error) { errors.push(error); }
    try { await fs.rm(lockFile, { force: true }); } catch (error) { errors.push(error); }
    if (errors.length && operationError) operationError.cleanup_errors = errors.map(error => ({ code: error.code, message: error.message }));
    if (errors.length && !operationError) throw errors[0];
  }
}

/** Diagnose the committed checkpoint; never execute, resume, or infer authority.
 * Boundaries cover only their referenced request, not siblings or descendants.
 * Missing decision requiredness and incomplete run observations fail closed.
 */
export function evaluateStop(state, options = {}) {
  validateJournal(state);
  return evaluateStopAssessment(state, options);
}
