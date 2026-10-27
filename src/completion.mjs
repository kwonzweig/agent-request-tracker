import { needsAttention } from './journal-views.mjs';

// Shared by the storage exit check and the browser's completion display.
// This module reads validated journal data; it has no host or filesystem access.
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function unresolvedDecision(state, decision, seen = new Set()) {
  if (seen.has(decision.id)) return true;
  if (decision.user_answer) return false;
  const replacement = decision.dismissal?.replacement;
  if (['dismissed', 'superseded'].includes(decision.status) && replacement?.collection === 'decisions') {
    const surviving = state.decisions.find(record => record.id === replacement.id);
    if (surviving && surviving.required !== false && surviving.request_id === decision.request_id) {
      seen.add(decision.id);
      return unresolvedDecision(state, surviving, seen);
    }
  }
  return true;
}

export function evaluateCompletion(state, { turnId } = {}) {
  if (!nonempty(turnId) || !state.turn || state.turn.id !== turnId ||
      state.history.at(-1)?.turn_id !== turnId || state.history.at(-1)?.revision !== state.revision) {
    return { allowed: false, reason: 'no saved checkpoint for this turn' };
  }
  const reason = state.turn.end_reason;
  if (!['complete', 'answer_delivered'].includes(reason)) {
    return { allowed: false, reason: 'no completion checkpoint for this turn' };
  }
  const required = state.decisions.filter(item => item.required !== false &&
    !['cancelled', 'proposed', 'deferred'].includes(state.requests.find(request => request.id === item.request_id)?.status) &&
    unresolvedDecision(state, item));
  if (required.length) return { allowed: false, reason: `${reason} checkpoint still lacks required choices: ${required.map(item => item.id).join(', ')}` };
  // Later changes attention only. An unresolved obstacle still contradicts
  // completion until its request is excluded or the blocker is closed.
  const blockers = state.blockers.filter(item => item.status === 'open' &&
    !['cancelled', 'proposed', 'deferred'].includes(state.requests.find(request => request.id === item.request_id)?.status));
  if (blockers.length) return { allowed: false, reason: `${reason} checkpoint still has unresolved blockers: ${blockers.map(item => item.id).join(', ')}` };
  const unfinished = state.requests.filter(request => ['active', 'waiting'].includes(request.status));
  return unfinished.length === 0
    ? { allowed: true, reason: `${reason} checkpoint has no unfinished authorized requests` }
    : { allowed: false, reason: `${reason} checkpoint leaves active or waiting requests unfinished: ${unfinished.map(r => r.id).join(', ')}` };
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasEvidence = value => nonempty(value) || (Array.isArray(value) && value.length > 0 && value.every(nonempty));

export function evaluateStopAssessment(state, { turnId } = {}) {
  if (!nonempty(turnId) || !state.turn || state.turn.id !== turnId ||
      state.history.at(-1)?.turn_id !== turnId || state.history.at(-1)?.revision !== state.revision) {
    return { allowed: false, reason: 'no saved checkpoint for this turn' };
  }
  const unfinished = state.requests.filter(request => ['active', 'waiting'].includes(request.status));
  const reason = state.turn.end_reason;
  // A referenced explicit pause wins over every remaining work item. Runtime
  // interrupts must additionally take precedence in the caller, even if no
  // checkpoint could be saved. An invalid checkpoint is not a resume command.
  if (reason === 'user_paused') {
    return nonempty(state.turn.pause_source) && state.turn.pause_source === state.turn.source
      ? { allowed: true, reason: 'user pause source is recorded' }
      : { allowed: false, reason: 'user pause checkpoint lacks an explicit pause source' };
  }
  if (reason === 'complete' || reason === 'answer_delivered') {
    return evaluateCompletion(state, { turnId });
  }
  const activeIds = new Set(unfinished.map(request => request.id));
  const decisions = state.decisions.filter(item => unresolvedDecision(state, item) && item.required === true &&
    activeIds.has(item.request_id) && needsAttention(item) && ['open', 'deferred'].includes(item.status) && !item.user_answer && Array.isArray(item.options) && item.options.length > 0);
  const blockers = state.blockers.filter(item => item.status === 'open' && activeIds.has(item.request_id) && needsAttention(item, 'blockers'));
  const run = state.turn.continuing_run;
  const running = object(run) && nonempty(run.id) && run.status === 'running' &&
    hasEvidence(run.evidence) && run.observed_turn_id === turnId && Array.isArray(run.request_ids)
    ? run.request_ids.filter(id => activeIds.has(id)) : [];
  const declaredBoundary = reason === 'decision' ? decisions.length > 0
    : reason === 'blocker' ? blockers.length > 0
    : reason === 'background' ? running.length > 0 : false;
  if (!declaredBoundary) {
    return { allowed: false, reason: `${reason ?? 'progress'} checkpoint has no applicable recorded stop boundary` };
  }
  const covered = new Set([...decisions, ...blockers].map(item => item.request_id).concat(running));
  const uncovered = unfinished.filter(request => !covered.has(request.id));
  return uncovered.length
    ? { allowed: false, reason: `active or waiting requests lack an applicable boundary: ${uncovered.map(r => r.id).join(', ')}` }
    : { allowed: true, reason: 'all active or waiting requests have a recorded required decision, blocker, or evidenced continuing run' };
}
