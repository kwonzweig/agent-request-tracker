import { journalAt, recordCollections } from './reply-ui.mjs';

export function attentionState(record) {
  const answer = record.user_answer;
  const currentAnswer = answer != null && answer.revision === record.revision && typeof answer.source === 'string' && answer.source.trim() &&
    ((typeof answer.text === 'string' && answer.text.trim()) || record.options?.some(option => option.id === answer.option_id));
  return record.attention?.state ?? (record.status === 'deferred' ? 'later'
    : currentAnswer && (record.question != null || record.type === 'suggestion') ? 'acknowledged' : 'pending');
}

export function needsAttention(record, collection) {
  if (['resolved', 'superseded', 'dismissed'].includes(record.status) ||
      (record.status === 'answered' && !['qa', 'note', 'completion'].includes(record.type))) return false;
  // An old acknowledgment is retained history, not proof that an obstacle cleared.
  if (collection === 'blockers' && record.status === 'open') return attentionState(record) !== 'later';
  return attentionState(record) === 'pending';
}

export function attentionItems(journal) {
  return ['decisions', 'blockers', 'cards'].flatMap(collection => (journal[collection] ?? [])
    .filter(record => needsAttention(record, collection)).map(record => ({ collection, record })))
    .sort((a, b) => Number(b.record.nudge?.priority === 'high') - Number(a.record.nudge?.priority === 'high'));
}

export function inheritedWorkspace(journal, requestId) {
  const requests = new Map((journal.requests ?? []).map(request => [request.id, request]));
  const seen = new Set();
  for (let request = requests.get(requestId); request && !seen.has(request.id); request = requests.get(request.parent_id)) {
    if (Object.hasOwn(request, 'workspace')) return request.workspace ?? null;
    seen.add(request.id);
  }
  return null;
}

// Labels are for display. The full canonical URL, including query and fragment,
// identifies the external workspace; callers can disambiguate repeated labels.
export function workspaceGroups(requests) {
  const groups = new Map();
  for (const request of requests) {
    const workspace = inheritedWorkspace({ requests }, request.id);
    const url = workspace == null ? null : new URL(workspace.url).href;
    const key = url ?? 'unlinked';
    if (!groups.has(key)) groups.set(key, {
      key, label: url === null ? 'Unlinked' : workspace.id, url, requests: [],
    });
    groups.get(key).requests.push(request);
  }
  return [...groups.values()];
}

function newAnswer(before, after) {
  const answer = after?.user_answer;
  return answer != null && (before?.user_answer == null ||
    ['revision', 'source', 'option_id', 'text'].some(field => answer[field] !== before.user_answer[field]));
}

// Collect observed actions as well as boundary snapshots. An intermediate state
// transition remains visible even when another save restores the original state.
export function turnChanges(journal, turnId) {
  const events = (journal.history ?? []).filter(event => event.turn_id === turnId && event.revision <= journal.revision);
  if (!events.length) return [];
  const endRevision = events.at(-1).revision;
  const snapshots = new Map();
  function recordAt(revision, collection, id) {
    if (!snapshots.has(revision)) snapshots.set(revision, journalAt(journal, revision));
    return snapshots.get(revision)[collection]?.find(record => record.id === id) ?? null;
  }
  const rows = new Map();
  function entity(collection, id) {
    const key = `${collection}:${id}`;
    if (!rows.has(key)) {
      const record = recordAt(endRevision, collection, id);
      rows.set(key, { collection, id, before: structuredClone(record), after: structuredClone(record),
        actions: new Set(), replies: [], hasWrites: false });
    }
    return rows.get(key);
  }
  for (const event of events) {
    for (const change of event.changes) {
      if (recordCollections.includes(change.collection)) {
        const row = entity(change.collection, change.id);
        if (!row.hasWrites) row.before = structuredClone(change.before);
        row.after = structuredClone(change.after);
        row.hasWrites = true;
        row.actions.add(change.before == null ? 'created' : 'updated');
        if (change.before != null && change.before.status !== change.after?.status) row.actions.add('status_changed');
        if (newAnswer(change.before, change.after)) row.actions.add('answered');
      } else if (change.collection === 'replies') {
        for (const item of change.after.items) {
          const row = entity(item.collection, item.id);
          row.actions.add({ comment: 'commented', answer: 'answered', defer: 'deferred', acknowledge: 'acknowledged', resolve: 'resolution_reported' }[item.kind]);
          row.replies.push({ ...structuredClone(item), reply_id: change.id, source: change.after.source,
            target: structuredClone(recordAt(item.record_revision, item.collection, item.id)) });
        }
      }
    }
  }
  return [...rows.values()].map(({ hasWrites, actions, ...row }) => ({ ...row, actions: [...actions] }));
}
