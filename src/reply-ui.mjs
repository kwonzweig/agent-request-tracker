import { actionVersionChanged } from './record-freshness.mjs';

export const recordCollections = ['requests', 'decisions', 'blockers', 'cards'];

export function normalizeJournal(journal) {
  return { ...journal, ...Object.fromEntries([...recordCollections, 'replies', 'history'].map(key =>
    [key, Array.isArray(journal[key]) ? journal[key] : []])) };
}

export function journalAt(journal, revision = journal.revision) {
  const state = structuredClone(normalizeJournal(journal));
  for (const event of [...state.history].reverse()) {
    if (event.revision <= revision) continue;
    for (const change of [...event.changes].reverse()) {
      if (change.collection === 'turn') { state.turn = change.before; continue; }
      if (!Array.isArray(state[change.collection])) continue;
      const records = state[change.collection], index = records.findIndex(record => record.id === change.id);
      if (change.before == null) { if (index >= 0) records.splice(index, 1); }
      else if (index >= 0) records[index] = structuredClone(change.before);
      else records.push(structuredClone(change.before));
    }
  }
  state.revision = revision;
  return state;
}

export function recordRevision(journal, collection, id) {
  return [...journal.history].reverse().find(event => event.revision <= journal.revision &&
    event.changes.some(change => change.collection === collection && change.id === id && actionVersionChanged(collection, change.before, change.after)))?.revision ?? journal.revision;
}

export function historyTurns(journal) {
  const turns = [];
  for (const event of journal.history) {
    const previous = turns.at(-1);
    if (previous?.id === event.turn_id) previous.revision = event.revision;
    else turns.push({ id: event.turn_id, revision: event.revision });
  }
  if (!turns.length && journal.revision) turns.push({ id: journal.turn?.id, revision: journal.revision });
  return turns;
}

export function hasChoices(collection, record) {
  return ['open', 'deferred'].includes(record.status) && !record.user_answer && (collection === 'decisions' ||
    collection === 'blockers' ||
    (collection === 'cards' && record.type === 'suggestion')) && Array.isArray(record.options) && record.options.length > 0;
}

export function canDefer(collection, record) {
  return ['open', 'deferred'].includes(record?.status) && (collection === 'blockers' || (!record.user_answer &&
    (collection === 'decisions' || (collection === 'cards' && record.type === 'suggestion'))));
}

export function canResolve(collection, record) {
  return record != null && ['open', 'answered'].includes(record.status) &&
    collection === 'cards' && ['qa', 'note', 'completion'].includes(record.type);
}

export function canAcknowledge(collection, record) {
  return record != null && ['decisions', 'cards'].includes(collection);
}

export function isRetiredBlockerAction(item) {
  return item?.collection === 'blockers' && ['resolve', 'acknowledge'].includes(item.kind);
}

export function draftKey(item) {
  return JSON.stringify([item.collection, item.id, item.record_revision, item.kind]);
}

export function replyItem(draft) {
  const item = { collection: draft.collection, id: draft.id, record_revision: draft.record_revision, kind: draft.kind };
  if (draft.kind === 'answer' && draft.option_id != null) item.option_id = draft.option_id;
  if (['answer', 'comment'].includes(draft.kind) && draft.text != null) item.text = draft.text.trim();
  return item;
}

const sameItems = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function receiptItem(item) {
  const value = { collection: item.collection, id: item.id, record_revision: item.record_revision, kind: item.kind };
  if (item.option_id !== undefined) value.option_id = item.option_id;
  if (item.text !== undefined) value.text = item.text;
  return value;
}
function validItem(item) {
  // Saved drafts and deliveries can contain retired Blocker actions.
  // Keep them readable as unsent history and for receipt reconciliation.
  return item && recordCollections.includes(item.collection) && typeof item.id === 'string' &&
    Number.isSafeInteger(item.record_revision) && item.record_revision > 0 && ['answer', 'comment', 'defer', 'acknowledge', 'resolve'].includes(item.kind) &&
    (item.kind !== 'acknowledge' || item.collection !== 'requests') &&
    (item.kind !== 'defer' || ['decisions', 'blockers', 'cards'].includes(item.collection)) &&
    (item.kind !== 'resolve' || ['blockers', 'cards'].includes(item.collection)) &&
    (item.option_id == null || typeof item.option_id === 'string') && (item.text == null || typeof item.text === 'string');
}

class DraftStorageAccessError extends Error {}
function readDraftStorage(read) {
  try { return read(); } catch { throw new DraftStorageAccessError(); }
}
function frozenDelivery(delivery) {
  const value = { id: delivery.id, conversation_id: delivery.conversation_id, items: delivery.items, tokens: delivery.tokens };
  if (delivery.outbound !== undefined) value.outbound = delivery.outbound;
  return structuredClone(value);
}

// A delivery is written before calling the host. A lost acknowledgement therefore
// remains locked after a reload; only the agent's immutable receipt releases it.
export class ReplyDrafts {
  constructor(storage, conversationId) {
    this.storage = storage;
    this.conversationId = conversationId;
    this.key = `request-journal:replies:v1:${conversationId}`;
    this.drafts = new Map();
    this.delivery = null;
    this.deliveryAttempt = { generation: 0, status: 'initial' };
    this.settledDeliveryId = null;
    this.storageAvailable = true;
    this.writeFailed = false;
    this.receiptMismatch = false;
    this.deliveryKey = `${this.key}:delivery`;
    this.itemPrefix = `${this.key}:item:`;
    this.instanceId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    this.lockManager = globalThis.navigator?.locks;
    this.refresh();
    // Reloads cannot establish that a previously staged host call completed.
    if (this.delivery) this.delivery = { ...this.delivery, status: 'uncertain' };
  }

  refresh() {
    try {
      const raw = readDraftStorage(() => this.storage.getItem(this.key));
      const saved = raw ? JSON.parse(raw) : { version: 1, drafts: [], delivery: null };
      if (saved.version !== 1 || !Array.isArray(saved.drafts)) throw new Error('Unrecognized saved drafts');
      const drafts = new Map();
      for (const draft of saved.drafts) {
        if (!validItem(draft) || typeof draft.token !== 'string') throw new Error('Invalid saved draft');
        drafts.set(draftKey(draft), draft);
      }
      // Per-surface item cells prevent stale deletes/receipt cleanup from
      // overwriting concurrent edits. Each surface retains only its latest operation
      // per item; deletion cutoffs cover older cells without erasing newer edits.
      const operations = [];
      if (typeof this.storage.key === 'function') for (let index = 0; index < readDraftStorage(() => this.storage.length); index++) {
        const key = readDraftStorage(() => this.storage.key(index));
        if (!key?.startsWith(this.itemPrefix)) continue;
        const operation = JSON.parse(readDraftStorage(() => this.storage.getItem(key)));
        if (!operation || typeof operation.key !== 'string' || !Number.isSafeInteger(operation.sequence) ||
          typeof operation.id !== 'string' || (operation.draft !== null &&
          (!validItem(operation.draft) || typeof operation.draft.token !== 'string' || draftKey(operation.draft) !== operation.key)))
          throw new Error('Invalid saved draft operation');
        operations.push(operation);
      }
      operations.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
      this.sequence = operations.at(-1)?.sequence ?? 0;
      this.observedOperations = new Map();
      for (const operation of operations) {
        const versions = this.observedOperations.get(operation.key) ?? [];
        versions.push([operation.sequence, operation.id]); this.observedOperations.set(operation.key, versions);
      }
      this.itemVersions = new Map();
      for (const operation of operations) {
        const current = this.itemVersions.get(operation.key) ?? [0, ''];
        const cutoff = operation.deletedVersion;
        const covered = cutoff && (current[0] < cutoff[0] || (current[0] === cutoff[0] && current[1] <= cutoff[1]));
        if (operation.draft !== null) {
          if (operation.expectedToken !== undefined && drafts.get(operation.key)?.token !== operation.expectedToken && !covered) continue;
          drafts.set(operation.key, operation.draft);
          this.itemVersions.set(operation.key, [operation.sequence, operation.id]);
        } else if (drafts.get(operation.key)?.token === operation.deletedToken || covered) {
          drafts.delete(operation.key);
          this.itemVersions.set(operation.key, [operation.sequence, operation.id]);
        }
      }
      // Sorting gives a stable display value, but does not resolve concurrent
      // semantic choices. A replacement only supersedes the versions it observed.
      const actionOperations = new Map();
      for (const operation of operations) {
        if (operation.draft?.kind === 'comment') continue;
        const group = actionOperations.get(operation.key) ?? [];
        group.push(operation); actionOperations.set(operation.key, group);
      }
      this.actionConflicts = new Map();
      this.actionCandidates = new Map();
      for (const [key, group] of actionOperations) {
        const concurrent = group.filter(operation => operation.draft !== null && !group.some(other => {
          if (other === operation || !other.deletedVersion) return false;
          if (other.expectedToken !== undefined) return operation.draft?.token === other.expectedToken;
          if (Array.isArray(other.observedVersions)) return other.observedVersions.some(([sequence, id]) =>
            sequence === operation.sequence && id === operation.id);
          const [sequence, id] = other.deletedVersion;
          return operation.sequence < sequence || (operation.sequence === sequence && operation.id <= id);
        })).map(operation => operation.draft);
        this.actionCandidates.set(key, concurrent);
        // Rebuild the selected action from the same surviving candidates used
        // for conflicts. Receipt cleanup must not hide an unsubmitted branch.
        if (concurrent.length) drafts.set(key, concurrent.at(-1));
        else if (group.some(operation => operation.draft !== null)) drafts.delete(key);
        if (new Set(concurrent.map(draft => JSON.stringify(replyItem(draft)))).size > 1) this.actionConflicts.set(key, concurrent);
      }
      const deliveryRaw = readDraftStorage(() => this.storage.getItem(this.deliveryKey));
      const delivery = deliveryRaw === null ? saved.delivery : JSON.parse(deliveryRaw);
      if (delivery != null && (typeof delivery.id !== 'string' || delivery.conversation_id !== this.conversationId ||
        !Array.isArray(delivery.items) || !delivery.items.every(validItem) || !Array.isArray(delivery.tokens) ||
        delivery.tokens.length !== delivery.items.length)) throw new Error('Invalid saved delivery');
      const settled = delivery && readDraftStorage(() => this.storage.getItem(`${this.deliveryKey}:receipt:${delivery.id}`)) === 'settled';
      const attemptRaw = delivery && readDraftStorage(() => this.storage.getItem(`${this.deliveryKey}:attempt:${delivery.id}`));
      const attempt = attemptRaw ? JSON.parse(attemptRaw) : { generation: 0, status: 'initial' };
      if (!Number.isSafeInteger(attempt?.generation) || attempt.generation < 0 ||
        !['initial', 'reserved', 'waiting', 'uncertain'].includes(attempt.status) ||
        (attempt.status === 'initial' && attempt.generation !== 0)) throw new Error('Invalid saved delivery attempt');
      this.drafts = drafts;
      this.deliveryAttempt = attempt;
      this.delivery = delivery && !settled ?
        { ...delivery, status: this.localDeliveryStatus?.id === delivery.id && this.localDeliveryStatus.generation === attempt.generation ? this.localDeliveryStatus.status : 'uncertain' } : null;
      if (settled) this.settledDeliveryId = delivery.id;
      // A readable store does not prove a failed write has recovered. Only a
      // successful explicit edit or receipt cleanup can establish that.
      this.storageAvailable = !this.writeFailed;
      this.storageFailure = this.writeFailed ? 'write' : null;
      return true;
    } catch (error) {
      this.storageAvailable = false;
      this.storageFailure = error instanceof DraftStorageAccessError ? 'access' : 'data';
      return false;
    }
  }

  // Lifecycle persistence is read-only: only an explicit item operation writes.
  persist() { return this.refresh(); }

  writeItem(key, draft, expectedToken, receiptCell) {
    try {
      if (typeof this.storage.key === 'function') {
        const id = receiptCell ?? `${this.instanceId}:${key}`;
        const operation = { key, id, sequence: this.sequence + 1, draft,
          deletedToken: draft === null ? this.drafts.get(key)?.token : undefined,
          deletedVersion: expectedToken === undefined ? this.itemVersions.get(key) ?? [0, ''] : [0, ''],
          observedVersions: expectedToken === undefined ? this.observedOperations.get(key) ?? [] : [], expectedToken };
        this.storage.setItem(this.itemPrefix + id, JSON.stringify(operation));
      }
      else {
        // Minimal storage adapters without enumeration are synchronous test hosts.
        if (draft === null) this.drafts.delete(key); else this.drafts.set(key, draft);
        this.storage.setItem(this.key, JSON.stringify({ version: 1, drafts: [...this.drafts.values()], delivery: this.delivery }));
      }
      this.writeFailed = false;
      return this.refresh();
    } catch { this.storageAvailable = false; this.writeFailed = true; this.storageFailure = 'write'; return false; }
  }

  set(item, token) {
    if (isRetiredBlockerAction(item)) return false;
    const observed = new Map(this.drafts);
    const observedConflicts = new Map(this.actionConflicts);
    if (!this.refresh()) return false;
    this.sharedConflict = false;
    this.sharedConflictTargets = [];
    if (item.kind !== 'comment' && [...this.actionConflicts].some(([key, alternatives]) =>
      alternatives.some(old => !isRetiredBlockerAction(old) && old.collection === item.collection && old.id === item.id &&
        !(observedConflicts.get(key) ?? []).some(known => known.token === old.token)))) {
      this.sharedConflict = true;
      this.sharedConflictTargets = [{ collection: item.collection, id: item.id, record_revision: item.record_revision, kind: item.kind }];
      return false;
    }
    if (item.kind !== 'comment' && [...this.drafts].some(([key, old]) => old.kind !== 'comment' && !isRetiredBlockerAction(old) &&
      old.collection === item.collection && old.id === item.id && observed.get(key)?.token !== old.token)) {
      this.sharedConflict = true;
      this.sharedConflictTargets = [{ collection: item.collection, id: item.id, record_revision: item.record_revision, kind: item.kind }];
      return false;
    }
    if (item.kind !== 'comment') for (const [key, old] of this.drafts) {
      if (old.kind !== 'comment' && !isRetiredBlockerAction(old) && old.collection === item.collection && old.id === item.id &&
        observed.get(key)?.token === old.token) this.writeItem(key, null);
    }
    const key = draftKey(item);
    if (item.kind === 'comment' && !item.text?.trim()) {
      if (this.drafts.get(key)?.token !== observed.get(key)?.token) return false;
      return this.writeItem(key, null);
    }
    return this.writeItem(key, { ...item, token });
  }

  remove(key) {
    const token = this.drafts.get(key)?.token;
    if (!this.refresh() || this.drafts.get(key)?.token !== token) return false;
    return this.writeItem(key, null);
  }

  inspect(journal) {
    const stale = [], invalid = [], items = [];
    const actionCounts = new Map();
    for (const draft of this.drafts.values()) if (draft.kind !== 'comment' && !isRetiredBlockerAction(draft)) {
      const target = JSON.stringify([draft.collection, draft.id]);
      actionCounts.set(target, (actionCounts.get(target) ?? 0) + 1);
    }
    for (const draft of this.drafts.values()) {
      const record = journal[draft.collection]?.find(record => record.id === draft.id);
      if (isRetiredBlockerAction(draft)) { stale.push(draft); continue; }
      if (draft.kind !== 'comment') {
        const alternatives = this.actionConflicts?.get(draftKey(draft));
        if (alternatives) { stale.push(...alternatives); continue; }
        if (actionCounts.get(JSON.stringify([draft.collection, draft.id])) > 1) { stale.push(draft); continue; }
        const eligible = draft.kind === 'answer' ? record && hasChoices(draft.collection, record)
          : draft.kind === 'defer' ? canDefer(draft.collection, record)
          : draft.kind === 'resolve' ? canResolve(draft.collection, record) : canAcknowledge(draft.collection, record);
        if (draft.review_needed || !eligible || recordRevision(journal, draft.collection, draft.id) !== draft.record_revision ||
          (draft.kind === 'answer' && draft.option_id != null && !record.options.some(option => option.id === draft.option_id))) { stale.push(draft); continue; }
        if (draft.kind === 'answer' && draft.option_id == null && !draft.text?.trim()) { invalid.push(draft); continue; }
      }
      items.push(replyItem(draft));
    }
    return { stale, invalid, items };
  }

  stage(id, items, outbound) {
    if (items.some(isRetiredBlockerAction)) return false;
    if (!this.refresh() || this.delivery) return false;
    try {
      if (this.storage.getItem(`${this.deliveryKey}:receipt:${id}`) === 'settled') return false;
    } catch { this.storageAvailable = false; this.storageFailure = 'access'; return false; }
    const targets = items.filter(item => item.kind !== 'comment').map(item => JSON.stringify([item.collection, item.id]));
    if (new Set(targets).size !== targets.length) return false;
    // Inspecting an earlier snapshot is insufficient: a competing action can
    // arrive while waiting for the delivery lock. Check the complete refreshed
    // group for every action target, even when the outgoing batch is a subset.
    const sharedCounts = new Map();
    for (const draft of this.drafts.values()) if (draft.kind !== 'comment' && !isRetiredBlockerAction(draft)) {
      const target = JSON.stringify([draft.collection, draft.id]);
      sharedCounts.set(target, (sharedCounts.get(target) ?? 0) + 1);
    }
    const conflictedTargets = targets.filter(target => sharedCounts.get(target) > 1 || [...(this.actionConflicts?.values() ?? [])].some(alternatives =>
      alternatives.some(draft => !isRetiredBlockerAction(draft) && JSON.stringify([draft.collection, draft.id]) === target)));
    if (conflictedTargets.length) {
      this.sharedConflict = true;
      this.sharedConflictTargets = conflictedTargets.map(target => {
        const [collection, id] = JSON.parse(target);
        const item = items.find(item => item.collection === collection && item.id === id && item.kind !== 'comment');
        return { collection, id, record_revision: item.record_revision, kind: item.kind };
      });
      return false;
    }
    // A stale view must review the shared edits before it can freeze a batch.
    if (!items.every(item => sameItems(replyItem(this.drafts.get(draftKey(item)) ?? {}), item))) return false;
    const delivery = { id, conversation_id: this.conversationId, items: structuredClone(items),
      tokens: items.map(item => this.drafts.get(draftKey(item))?.token), status: 'sending' };
    if (outbound !== undefined) delivery.outbound = structuredClone(outbound);
    try {
      const attempt = { generation: 0, status: 'initial' };
      this.storage.setItem(`${this.deliveryKey}:attempt:${id}`, JSON.stringify(attempt));
      this.storage.setItem(this.deliveryKey, JSON.stringify(delivery));
      this.writeFailed = false;
      this.storageAvailable = true;
      this.storageFailure = null;
      this.delivery = delivery;
      this.deliveryAttempt = attempt;
      this.localDeliveryStatus = { id, status: 'sending', generation: 0 };
      return true;
    } catch { this.storageAvailable = false; this.writeFailed = true; this.storageFailure = 'write'; return false; }
  }

  async stageAsync(id, items, outbound) {
    if (!this.lockManager?.request || typeof this.storage.key !== 'function') {
      this.coordinationUnavailable = true;
      return false;
    }
    try {
      return await this.lockManager.request(this.deliveryKey, { mode: 'exclusive' }, () => this.stage(id, items, outbound));
    } catch { this.coordinationUnavailable = true; return false; }
  }

  deliveryStatus(status, id, generation = 0) {
    if (typeof id !== 'string' || !id.trim() || !Number.isSafeInteger(generation) || generation < 0 ||
      !this.refresh() || this.delivery?.id !== id || this.deliveryAttempt.generation !== generation) return false;
    try {
      this.delivery = { ...this.delivery, status };
      this.localDeliveryStatus = { id, status, generation };
      // Status is presentation only. The immutable pending cell stays frozen
      // until receipt reconciliation, so an old surface cannot resurrect it.
      return true;
    } catch { this.storageAvailable = false; return false; }
  }

  pendingReview({ refresh = true } = {}) {
    const readable = refresh ? this.refresh() : !['access', 'data'].includes(this.storageFailure);
    if (!this.delivery) return null;
    return { delivery: frozenDelivery(this.delivery), generation: this.deliveryAttempt.generation,
      attempt: structuredClone(this.deliveryAttempt), status: this.delivery.status,
      canRetry: readable && !this.receiptMismatch && !this.coordinationUnavailable &&
        !!this.lockManager?.request && typeof this.storage.key === 'function' && this.delivery.status === 'uncertain' &&
        this.deliveryAttempt.status !== 'reserved' };
  }

  isDeliverySettled(id) {
    if (typeof id !== 'string' || !id.trim() || !this.refresh()) return false;
    try { return this.storage.getItem(`${this.deliveryKey}:receipt:${id}`) === 'settled'; }
    catch { this.storageAvailable = false; this.storageFailure = 'access'; return false; }
  }

  writeAttempt(id, attempt) {
    try {
      this.storage.setItem(`${this.deliveryKey}:attempt:${id}`, JSON.stringify(attempt));
      this.writeFailed = false;
      return this.refresh();
    } catch { this.storageAvailable = false; this.writeFailed = true; this.storageFailure = 'write'; return false; }
  }

  async retryDelivery(review, { getLatestJournal, transmit }) {
    const result = (status, generation = review?.generation) => ({ status, deliveryId: review?.delivery?.id, generation });
    if (!review?.canRetry || !review.delivery || typeof getLatestJournal !== 'function' || typeof transmit !== 'function') return result('changed');
    if (!this.lockManager?.request || typeof this.storage?.key !== 'function' || this.coordinationUnavailable) {
      this.coordinationUnavailable = true; return result('coordination_failed');
    }
    try {
      return await this.lockManager.request(this.deliveryKey, { mode: 'exclusive' }, async () => {
        const matches = () => this.delivery?.status === 'uncertain' && sameItems(frozenDelivery(this.delivery), review.delivery) &&
          this.deliveryAttempt.status !== 'reserved' && this.deliveryAttempt.generation === review.generation &&
          sameItems(this.deliveryAttempt, review.attempt);
        if (!this.refresh()) return result('storage_failed');
        if (!matches()) return result(this.settledDeliveryId === review.delivery.id ? 'settled' : 'changed');
        let journal;
        try { journal = await getLatestJournal(); } catch { return result('read_failed'); }
        if (!journal || journal.conversation_id !== review.delivery.conversation_id || !Array.isArray(journal.replies)) return result('read_failed');
        const receipt = journal.replies.find(reply => reply.id === review.delivery.id);
        if (receipt) {
          if (!Array.isArray(receipt.items) || !sameItems(receipt.items.map(receiptItem), review.delivery.items)) {
            this.receiptMismatch = true; return result('mismatch');
          }
          this.reconcile(journal);
          return result(this.settledDeliveryId === review.delivery.id && !this.delivery ? 'settled' : 'storage_failed');
        }
        if (this.receiptMismatch) return result('mismatch');
        if (!this.refresh()) return result('storage_failed');
        if (!matches()) return result(this.settledDeliveryId === review.delivery.id ? 'settled' : 'changed');
        const generation = review.generation + 1;
        if (!Number.isSafeInteger(generation)) return result('changed');
        if (!this.writeAttempt(review.delivery.id, { generation, status: 'reserved' })) return result('storage_failed', generation);
        if (!this.deliveryStatus('sending', review.delivery.id, generation)) return result('changed', generation);
        let status = 'waiting';
        try { await transmit(frozenDelivery(this.delivery), generation); } catch { status = 'uncertain'; }
        // Host success survives a failed bookkeeping read/write on this surface.
        // A reserved durable attempt cannot prove what occurred after a reload.
        this.localDeliveryStatus = { id: review.delivery.id, status, generation };
        if (this.delivery?.id === review.delivery.id && this.deliveryAttempt.generation === generation) this.delivery = { ...this.delivery, status };
        if (!this.refresh()) return result(status === 'waiting' ? 'sent' : 'uncertain', generation);
        if (this.settledDeliveryId === review.delivery.id && !this.delivery) return result('settled', generation);
        if (this.delivery?.id !== review.delivery.id || this.deliveryAttempt.generation !== generation) return result('changed', generation);
        if (!this.writeAttempt(review.delivery.id, { generation, status })) {
          return result(status === 'waiting' ? 'sent' : 'uncertain', generation);
        }
        this.deliveryStatus(status, review.delivery.id, generation);
        return result(status === 'waiting' ? 'sent' : 'uncertain', generation);
      });
    } catch { this.coordinationUnavailable = true; return result('coordination_failed'); }
  }

  async reconcileAsync(journal) {
    if (!this.lockManager?.request) return false;
    return this.lockManager.request(this.deliveryKey, { mode: 'exclusive' }, () => this.reconcile(journal));
  }

  reconcile(journal) {
    if (!this.refresh() || !this.delivery || journal.conversation_id !== this.delivery.conversation_id) return false;
    const receipt = journal.replies.find(reply => reply.id === this.delivery.id);
    if (!receipt) return false;
    if (!Array.isArray(receipt.items) || !sameItems(receipt.items.map(receiptItem), this.delivery.items)) { this.receiptMismatch = true; return false; }
    const delivery = this.delivery;
    for (const [index, item] of delivery.items.entries()) {
      const key = draftKey(item);
      const token = delivery.tokens[index];
      const candidates = this.actionCandidates?.get(key);
      const matched = (candidates?.length ? candidates : [this.drafts.get(key)]).find(draft => draft?.token === token);
      if (matched) {
        // Automatic cleanup is token-scoped and uses its own cell, never the
        // reconciling surface's current edit cell (which may hold another intent).
        if (!this.writeItem(key, receipt.items[index].outcome === 'stale' ? { ...matched, review_needed: true } : null,
          token, `receipt:${delivery.id}:${index}:${key}`)) return false;
      }
    }
    try {
      // Settlement is the final write, only after every matching draft cleanup
      // succeeds. Partial cleanup remains retryable with the pending batch locked.
      // A receipt settles only its immutable delivery ID. Concurrent staging
      // of a later delivery cannot be cleared by an older surface.
      this.storage.setItem(`${this.deliveryKey}:receipt:${delivery.id}`, 'settled');
      this.writeFailed = false;
      this.storageAvailable = true;
      this.storageFailure = null;
      this.delivery = null;
      this.settledDeliveryId = delivery.id;
      this.receiptMismatch = false;
      return true;
    } catch { this.storageAvailable = false; this.writeFailed = true; this.storageFailure = 'write'; return false; }
  }

}

export function safeActionUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\/[^\s\\]+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname ? url : null;
  } catch { return null; }
}

export function safeLinkUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\/[^\s\u0000-\u001f\u007f/?#\\@]+(?:[/?#][^\s\u0000-\u001f\u007f\\]*)?(?![\s\S])/i.test(value)) return null;
  return safeActionUrl(value);
}
