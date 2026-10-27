import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { normalizeJournal, journalAt, recordRevision, historyTurns, hasChoices, canDefer, canResolve, isRetiredBlockerAction, draftKey, ReplyDrafts, safeActionUrl, safeLinkUrl } from './reply-ui.mjs';
import { workspaceGroups, turnChanges, attentionState, needsAttention, attentionItems, inheritedWorkspace } from './journal-views.mjs';
import { formatReplyText } from './reply-text.mjs';
import { evaluateCompletion, evaluateStopAssessment } from './completion.mjs';

const app = new App({ name: 'Request Tracker', version: '0.6.0' });
const extensions = new OpenAIExtensions(app);
const $ = id => document.getElementById(id);
const root = $('rjc');
const types = { decisions: 'Decision', blockers: 'Blocker', suggestion: 'Suggestion', qa: 'Q&A', note: 'Note', completion: 'Complete' };
const statuses = { proposed: ['Proposed', 'neutral'], active: ['In progress', 'active'], waiting: ['Waiting', 'waiting'],
  working: ['Working', 'active'], blocked: ['Blocked', 'blocked'], deferred: ['Deferred', 'deferred'], done: ['Done', 'done'],
  cancelled: ['× Cancelled', 'cancelled'], open: ['Open', 'pending'], answered: ['Answered', 'answered'],
  superseded: ['Superseded', 'superseded'], resolved: ['✓ Resolved', 'resolved'], dismissed: ['Dismissed', 'neutral'] };
let current = null, drafts = null, tab = 'attention', requestFilter = 'active', requestView = 'tree', cardFilter = 'all', historyTurnId = null, revealedRequest = null;
let poll, reading = null, preparing = false, retrying = false, connected = false, sequence = 0, connectionNotice = { kind: 'read' };
const disclosures = new Map();
const otherEdits = new Map();
const markingRead = new Set();

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function add(parent, tag, text, className) { const node = el(tag, text, className); parent.append(node); return node; }
function text(value) { return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value); }
function button(parent, label, action, className) {
  const node = add(parent, 'button', label, className); node.type = 'button'; node.addEventListener('click', action); return node;
}
function badge(parent, label, kind = 'neutral') { return add(parent, 'span', label, `jc-badge ${kind}`); }
function statusPresentation(status, type) {
  return status === 'answered' && ['decision', 'suggestion'].includes(type) ? ['✓ Resolved', 'resolved']
    : statuses[status] || ['Unknown', 'neutral'];
}
function stateBadge(parent, status, family = 'card', record = null, type = record?.type) {
  const terminal = ['resolved', 'dismissed', 'superseded', 'done', 'cancelled'].includes(status) ||
    (status === 'answered' && !['qa', 'note', 'completion'].includes(record?.type));
  const later = family === 'card' && !terminal && (attentionState(record || {}) === 'later' || status === 'deferred');
  if (family === 'card' && ['qa', 'completion'].includes(record?.type) && ['open', 'answered'].includes(status) && !later) return;
  let [label, kind] = later ? ['Later', 'deferred'] : statusPresentation(status, type);
  if (status === 'done') label = '✓ Done';
  const node = badge(parent, label, `${kind} jc-${family}-status`);
  if (status === 'dismissed') node.title = 'This card no longer applies.';
  return node;
}
function selectValue(id, value) {
  for (const option of $(id).options) {
    option.toggleAttribute('selected', option.value === value);
  }
  const selected = [...$(id).options].find(option => option.value === value);
  if (selected) selected.selected = true;
}
function bindDisclosure(details, key, defaultOpen = false) {
  details.dataset.disclosure = key;
  details.toggleAttribute('open', disclosures.get(key) ?? defaultOpen);
  details.dataset.disclosureOpen = String(details.hasAttribute('open'));
  details.addEventListener('toggle', () => {
    const open = details.hasAttribute('open');
    if (details.isConnected && open !== (details.dataset.disclosureOpen === 'true')) {
      disclosures.set(key, open); details.dataset.disclosureOpen = String(open);
    }
  });
  return details;
}
function recordDisclosure(details, state, collection, record, place, defaultOpen = false) {
  if (details.tagName === 'DETAILS') bindDisclosure(details, JSON.stringify([place, collection, record.id, ...(place === 'history' ? [state.turn?.id] : [])]), defaultOpen);
}
function recordTitle(collection, record) { return collection === 'decisions' ? record.question : record.title; }
function recordType(collection, record) { return collection === 'cards' ? record.type : collection === 'requests' ? 'note' : collection === 'decisions' ? 'decision' : 'blocker'; }
function actionLink(parent, label, value, className) {
  const url = safeLinkUrl(value);
  if (!url) return null;
  const link = add(parent, 'a', label, className); link.href = url.href;
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.addEventListener('click', async event => {
    event.stopPropagation();
    if (typeof app.openLink !== 'function') return;
    event.preventDefault();
    try { await app.openLink({ url: url.href }); }
    catch { notice(`Could not open the link. Open this address in your browser: ${url.href}`, true); }
  });
  return link;
}
function requestLink(parent, state, record, prefix = '') {
  const request = state.requests.find(item => item.id === record.request_id);
  if (!request || !current.requests.some(item => item.id === request.id)) return;
  const link = button(parent, `↗ ${prefix ? `${prefix} · ` : ''}${request.title}`, event => {
    event.preventDefault(); event.stopPropagation(); revealRequest(request.id);
  }, 'jc-link jc-request-link');
  link.dataset.requestLink = request.id;
  return link;
}
function revealRequest(id) {
  const target = current.requests.find(record => record.id === id);
  if (!target) return;
  if (!visibleRequestIds().has(id)) requestFilter = 'all';
  tab = 'requests'; requestView = 'tree'; revealedRequest = id;
  render();
  const row = [...$('jc-tree').querySelectorAll('.jc-request')].find(node => node.dataset.record === id);
  if (!row) return;
  for (let node = row.parentElement; node && node !== $('jc-tree'); node = node.parentElement) {
    if (node.tagName !== 'DETAILS') continue;
    node.setAttribute('open', ''); disclosures.set(node.dataset.disclosure, true);
  }
  const details = row.firstElementChild;
  details.setAttribute('open', ''); disclosures.set(details.dataset.disclosure, true);
  const summary = details.firstElementChild;
  summary.focus({ preventScroll: true });
  summary.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}
function titleFor(item) {
  const journal = journalAt(current, item.record_revision);
  const record = journal[item.collection].find(record => record.id === item.id);
  return record ? recordTitle(item.collection, record) : 'Earlier record';
}
function binding(state, collection, record, kind) {
  return { collection, id: record.id, record_revision: recordRevision(state, collection, record.id), kind };
}
function editToken() { return `${Date.now()}:${++sequence}:${Math.random()}`; }
function notice(message, error = false, kind = 'action', deliveryId = null) { connectionNotice = { kind, deliveryId }; $('connection').textContent = message; $('connection').hidden = !message; $('connection').className = `jc-connection${error ? ' error' : ''}`; }
function clearConfirmedNotice() {
  if (connectionNotice.kind === 'read' || (connectionNotice.kind === 'delivery' && drafts.isDeliverySettled(connectionNotice.deliveryId))) notice('');
}

function applyHostContext(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
app.onhostcontextchanged = applyHostContext;

function editDraft(item) {
  const key = draftKey(item);
  const surrounding = () => JSON.stringify([
    [...drafts.drafts].filter(([savedKey]) => savedKey !== key),
    [...(drafts.actionConflicts ?? [])],
  ]);
  const before = surrounding();
  const accepted = drafts.set(item, editToken());
  const effective = drafts.drafts.get(key);
  const sameEdit = item.kind === 'comment' && !item.text?.trim() ? !effective
    : effective?.kind === item.kind && effective.text === item.text && effective.option_id === item.option_id;
  // Every edit can import other views' changes. Updating only the reply count
  // would leave controls showing a different batch from the one Send can use.
  if (before !== surrounding() || (drafts.storageAvailable && (!accepted || !sameEdit))) render();
  else renderReplyBar();
  return accepted;
}

function commentBox(parent, state, collection, record, place, cardTools = false) {
  const item = binding(state, collection, record, 'comment'), key = draftKey(item);
  const wrapper = add(parent, 'div', undefined, 'jc-comment jc-input');
  const id = `jc-comment-${place}-${encodeURIComponent(key)}`;
  const disclosure = JSON.stringify(['comment', place, key]);
  const toolbar = cardTools ? add(wrapper, 'div', undefined, 'jc-card-tools') : wrapper;
  const control = button(toolbar, undefined, () => {
    const open = editor.hidden;
    disclosures.set(disclosure, open); editor.hidden = !open; control.setAttribute('aria-expanded', String(open));
    if (open) input.focus();
  }, 'jc-comment-toggle');
  control.setAttribute('aria-label', `Comment · ${recordTitle(collection, record)}`); control.title = 'Comment';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 4h16v12H9l-5 4V4Z'); icon.append(path); control.append(icon);
  const editor = add(wrapper, 'div', undefined, 'jc-comment-editor'); editor.id = `${id}-editor`;
  editor.hidden = !(disclosures.get(disclosure) ?? false);
  control.setAttribute('aria-controls', editor.id); control.setAttribute('aria-expanded', String(!editor.hidden));
  const label = add(editor, 'label', 'Comment'); label.htmlFor = id;
  const input = add(editor, 'textarea'); input.id = id; input.rows = 2; input.maxLength = 4000;
  input.setAttribute('aria-label', `Comment · ${recordTitle(collection, record)}`); input.dataset.draftKey = key;
  input.value = drafts.drafts.get(key)?.text || '';
  input.addEventListener('input', () => {
    if (!input.isConnected) return;
    const value = input.value;
    if (!editDraft({ ...item, text: value }) || !input.isConnected) return;
    for (const other of root.querySelectorAll('textarea[data-draft-key]')) if (other !== input && other.dataset.draftKey === key) other.value = value;
  });
  return wrapper;
}

function trimUrl(value) {
  let candidate = value.replace(/[.,;!?]+$/, '');
  while (candidate.endsWith(')') && (candidate.match(/\)/g)?.length || 0) > (candidate.match(/\(/g)?.length || 0)) candidate = candidate.slice(0, -1);
  candidate = candidate.replace(/\]+$/, '');
  return candidate;
}
function legacyUrl(value) { return safeLinkUrl(trimUrl(value)); }
function displayText(value, linksOnly = false) {
  const source = text(value).replace(/[ \t]+/g, ' ').trim();
  if (linksOnly && (Array.isArray(value) ? value : [value]).every(value => ![...textParts(value)]
    .map(part => typeof part === 'string' ? part : part.explicit ? part.label : '').join('')
    .replace(/[\s()[\].,;!?]+/g, ''))) return '';
  return source;
}
function compactUrl(url) { return `${url.protocol === 'https:' ? '' : url.protocol + '//'}${url.host}${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`; }
function* textParts(value) {
  const source = text(value);
  const pattern = /\[([^\]]+)\]\((https?:\/\/)|https?:\/\/[^\s<>"']+/gi;
  let offset = 0, match;
  while ((match = pattern.exec(source))) {
    yield source.slice(offset, match.index);
    let candidate = match[0], explicit = false;
    if (match[2]) {
      const start = pattern.lastIndex - match[2].length;
      let cursor = start, depth = 0;
      // Explicit destinations end at their own balanced closing delimiter,
      // not a surrounding prose parenthesis or the next adjacent link.
      for (; cursor < source.length && !/\s/.test(source[cursor]); cursor++) {
        if (source[cursor] === '(') depth++;
        else if (source[cursor] === ')') { if (depth === 0) break; depth--; }
      }
      if (source[cursor] === ')' && depth === 0) {
        candidate = source.slice(start, cursor); explicit = true;
        pattern.lastIndex = cursor + 1;
      }
    }
    const url = explicit ? safeLinkUrl(candidate) : match[2] ? null : legacyUrl(candidate);
    if (url) {
      yield { url, label: explicit ? match[1] : trimUrl(candidate), explicit };
      if (!explicit) yield candidate.slice(trimUrl(candidate).length);
    } else yield source.slice(match.index, pattern.lastIndex);
    offset = pattern.lastIndex;
  }
  yield source.slice(offset);
}
function replyText(parent, value, { tag = 'p', className, compact = false } = {}) {
  const row = add(parent, tag, undefined, className);
  for (const part of textParts(value)) {
    if (typeof part === 'string') row.append(document.createTextNode(part));
    else actionLink(row, compact && !part.explicit ? compactUrl(part.url) : part.label, part.url.href, 'jc-reply-link');
  }
  return row;
}
function linkedContext(state, record, requestId = record.request_id) {
  const workspace = inheritedWorkspace(state, requestId), links = new Map();
  const workspaceUrl = safeLinkUrl(workspace?.url)?.href;
  function include(label, value, action = false) {
    const url = safeLinkUrl(value);
    if (!url || url.href === workspaceUrl || links.has(url.href)) return;
    links.set(url.href, { label: label || url.hostname, url: url.href, action });
  }
  for (const link of record.urls || []) include(link.label, link.url);
  include(record.action_label || record.next_action, record.action_url, true);
  for (const value of [record.evidence, record.body, record.why, record.original_request, record.scope, record.done_when].flatMap(value => Array.isArray(value) ? value : [value])) {
    for (const part of textParts(value)) {
      if (typeof part !== 'string') include(part.url.hostname, part.url.href, record.action_url === part.url.href);
    }
  }
  const labels = new Map();
  for (const link of links.values()) labels.set(link.label, (labels.get(link.label) || 0) + 1);
  for (const link of links.values()) {
    const url = safeLinkUrl(link.url);
    if (labels.get(link.label) > 1 && link.label === url.hostname) link.label = compactUrl(url);
  }
  return { workspace, links: [...links.values()] };
}
function detailField(parent, label, value, seen = null) {
  const content = displayText(value, label === 'Evidence');
  if (!content || seen?.has(content)) return;
  seen?.add(content);
  const row = add(parent, 'div', undefined, 'jc-content-box jc-detail-field'); add(row, 'strong', label); replyText(row, content, { compact: true });
}
function drawLinks(parent, state, record, context, place, collection, requestReference = record, requestPrefix = '') {
  const row = add(parent, 'div', undefined, 'jc-record-refs jc-links');
  requestLink(row, state, requestReference, requestPrefix);
  if (context.workspace) actionLink(row, `↗ ${context.workspace.id}`, context.workspace.url, 'jc-link jc-workspace-link');
  for (const link of context.links) actionLink(row, `↗ ${link.label}`, link.url, 'jc-link jc-resource-link');
  if (!row.childElementCount) { row.remove(); return; }
  const links = [...row.children];
  if (links.length <= 2) return row;
  const key = JSON.stringify(['link-overflow', place, collection, record.id, ...(place === 'history' ? [state.turn?.id] : [])]);
  const overflow = add(row, 'span', undefined, 'jc-link-overflow');
  overflow.id = `jc-links-${encodeURIComponent(key)}`;
  links.slice(2).forEach(link => overflow.append(link));
  const control = button(row, '…', event => {
    event.preventDefault(); event.stopPropagation();
    const open = overflow.hidden;
    disclosures.set(key, open); overflow.hidden = !open;
    control.setAttribute('aria-expanded', String(open));
    control.setAttribute('aria-label', open ? 'Fewer links' : 'More links');
  }, 'jc-links-toggle');
  control.setAttribute('aria-controls', overflow.id);
  const open = disclosures.get(key) ?? false;
  overflow.hidden = !open; control.setAttribute('aria-expanded', String(open));
  control.setAttribute('aria-label', open ? 'Fewer links' : 'More links');
  row.insertBefore(control, overflow);
  return row;
}
function cardContext(parent, collection, record, history, seen) {
  if (collection === 'decisions') {
    detailField(parent, 'Without answer', record.no_answer_behavior, seen);
    detailField(parent, 'Agent assumption', record.agent_assumption, seen);
  }
  if (collection === 'blockers') detailField(parent, 'Next action', record.next_action, seen);
  if ((history || !hasChoices(collection, record)) && record.options?.length) {
    const options = add(parent, 'div', undefined, 'jc-content-box jc-option-context');
    add(options, 'strong', collection === 'blockers' ? 'Alternatives' : 'Options');
    for (const option of record.options) {
      const label = displayText(option.label);
      const row = replyText(options, record.recommendation === option.id ? label.replace(/\s*\((?:추천|Recommended)\)$/, '') : label, { compact: true });
      if (record.recommendation === option.id) add(row, 'span', ' Recommended', 'jc-recommendation');
      if (option.impact) replyText(options, displayText(option.impact), { className: 'jc-option-desc', compact: true });
    }
  }
}
function reminder(parent, record) {
  if (record.nudge?.priority === 'high') {
    const priority = add(parent, 'span', '!', 'jc-reminder'); priority.setAttribute('aria-label', 'High priority');
  }
}
function replyControl(parent, state, collection, record, place, kind, label, className) {
  const item = binding(state, collection, record, kind), key = draftKey(item);
  const control = button(parent, label, event => {
    event.preventDefault(); event.stopPropagation();
    if (kind === 'resolve') { void markRead(item); return; }
    if (drafts.drafts.has(key)) drafts.remove(key); else drafts.set(item, editToken());
    render();
  }, className);
  control.dataset.replyKind = kind; control.id = `jc-${kind}-${place}-${encodeURIComponent(key)}`;
  if (kind !== 'resolve') control.setAttribute('aria-pressed', String(drafts.drafts.has(key)));
  control.title = kind === 'resolve' ? 'Mark as read' : 'Postpone this item.';
  if (kind === 'resolve') {
    control.setAttribute('aria-label', `Mark as read · ${recordTitle(collection, record)}`);
    control.dataset.readKey = JSON.stringify([collection, record.id]);
  }
  return control;
}
function replyActions(parent, state, collection, record, place) {
  const actions = add(parent, 'div', undefined, 'jc-actions');
  if (canDefer(collection, record)) replyControl(actions, state, collection, record, place, 'defer', 'Later', 'jc-later-action');
  if (!actions.childElementCount) actions.remove();
}

function choices(parent, state, collection, record, place) {
  const item = binding(state, collection, record, 'answer'), key = draftKey(item), draft = drafts.drafts.get(key);
  const conflicts = drafts.actionConflicts?.get(key);
  if (conflicts?.length) {
    const box = add(parent, 'div', undefined, 'jc-content-box');
    add(box, 'p', 'Different replies were saved in other views. Choose your reply again.');
    const list = add(box, 'ul');
    for (const alternative of conflicts) add(list, 'li', alternative.option_id == null
      ? `Other: ${alternative.text || ''}` : record.options.find(option => option.id === alternative.option_id)?.label || alternative.option_id);
  }
  const options = add(parent, 'div', undefined, 'jc-options'); options.setAttribute('role', 'group');
  options.setAttribute('aria-label', recordTitle(collection, record));
  for (const option of [...record.options, { id: null, label: 'Other' }]) {
    const selected = !!draft && (option.id === null ? draft.option_id == null : draft.option_id === option.id);
    const choice = button(options, undefined, () => {
      const existing = drafts.drafts.get(key);
      const next = { ...item };
      const otherText = otherEdits.get(key) ?? existing?.other_text ?? existing?.text ?? '';
      if (option.id !== null) { next.option_id = option.id; next.other_text = otherText; }
      else { next.text = otherText; next.other_text = otherText; }
      drafts.set(next, editToken()); render();
    });
    choice.dataset.choice = option.id === null ? 'other' : option.id;
    choice.dataset.record = record.id;
    choice.id = `jc-choice-${place}-${encodeURIComponent(key)}-${encodeURIComponent(option.id || 'other')}`;
    choice.setAttribute('aria-pressed', String(selected));
    const recommended = option.id != null && record.recommendation === option.id;
    const label = recommended ? option.label.replace(/\s*\((?:추천|Recommended)\)$/, '') : option.label;
    const title = add(choice, 'span', undefined, 'jc-option-title'); add(title, 'span', label);
    if (recommended) add(title, 'span', 'Recommended', 'jc-recommendation');
    if (option.impact) add(choice, 'span', option.impact, 'jc-option-desc');
    const check = add(choice, 'span', '✓', 'jc-check'); check.setAttribute('aria-hidden', 'true');
  }
  if (draft && draft.option_id == null) {
    const wrapper = add(parent, 'div', undefined, 'jc-input');
    const id = `jc-other-${place}-${encodeURIComponent(key)}`;
    const label = add(wrapper, 'label', 'Other'); label.htmlFor = id;
    const input = add(wrapper, 'textarea'); input.id = id; input.rows = 2; input.maxLength = 4000;
    input.value = draft.text || ''; input.dataset.draftKey = key; input.setAttribute('aria-label', `Your answer · ${recordTitle(collection, record)}`);
    input.addEventListener('input', () => {
      // A rejected edit replaces this editor with the shared current choice.
      // Subsequent queued events from the old editor cannot approve a replacement.
      if (!input.isConnected) return;
      otherEdits.set(key, input.value);
      editDraft({ ...item, text: input.value, other_text: input.value });
    });
  }
}

function responseRow(parent, caption, recordedAt, action = null, actionKind = 'neutral', stale = false) {
  const row = add(parent, 'div', undefined, 'jc-user-reply');
  add(row, 'span', caption);
  const hasTime = typeof recordedAt === 'string' && Number.isFinite(Date.parse(recordedAt));
  if (action || hasTime) {
    const labels = add(row, 'div');
    if (action) badge(labels, action, actionKind);
    if (hasTime) {
      if (action) labels.append(document.createTextNode(' '));
      const time = add(labels, 'time', new Date(recordedAt).toLocaleString(), 'jc-badge jc-reply-time');
      time.setAttribute('datetime', recordedAt); time.title = 'Recorded at';
    }
  }
  if (stale) add(row, 'span', 'Review needed');
  return row;
}

function laterResponse(parent, caption, recordedAt, stale = false) {
  return responseRow(parent, caption, recordedAt, 'Later', 'deferred', stale);
}

function userReplies(parent, state, collection, record, replies = null) {
  const items = (replies ?? state.replies.flatMap(receipt => (receipt.items || []).map(item =>
    ({ ...item, source: receipt.source, reply_id: receipt.id })))).filter(item => item.collection === collection && item.id === record.id);
  for (const item of items) {
    const receipt = state.replies.find(receipt => receipt.id === item.reply_id);
    const chat = receipt?.input_method === 'chat' && item.kind !== 'comment';
    const blockerReport = item.kind === 'resolve' && collection === 'blockers';
    const caption = chat ? 'Recorded from your message' : {
      answer: 'User answered', comment: 'Your comment', defer: receipt?.input_method === 'card' ? 'User selected' : 'User chose',
      resolve: blockerReport ? 'User reported completion' : 'User marked as read', acknowledge: 'User acknowledged',
    }[item.kind] || 'User replied';
    const action = item.kind === 'defer' ? 'Later' : chat ? {
      answer: 'Answer', resolve: blockerReport ? 'Completion reported' : 'Marked as read', acknowledge: 'Acknowledged',
    }[item.kind] : null;
    const row = responseRow(parent, caption, receipt?.recorded_at, action, item.kind === 'defer' ? 'deferred' : 'neutral', item.outcome === 'stale');
    const original = item.target || journalAt(current, item.record_revision)[collection].find(candidate => candidate.id === record.id);
    const value = item.text || original?.options?.find(option => option.id === item.option_id)?.label;
    if (value) replyText(row, value);
    if (original && recordTitle(collection, original) !== recordTitle(collection, record)) add(row, 'p', `On: ${recordTitle(collection, original)}`, 'jc-reply-context');
  }
  return items;
}

function hasAnswerReceipt(state, collection, record, replies = null) {
  const answer = record.user_answer;
  if (!answer) return false;
  const items = replies ?? state.replies.flatMap(receipt => receipt.items.map(item => ({ ...item, source: receipt.source })));
  return items.some(item => {
    if (item.source !== answer.source || item.collection !== collection || item.id !== record.id) return false;
    const matches = item.kind === 'answer' ? item.outcome === 'accepted' &&
      (item.option_id ?? null) === (answer.option_id ?? null) && (item.text ?? '') === (answer.text ?? '')
      : item.kind === 'comment' && (item.outcome === 'accepted' || item.outcome === undefined) &&
        answer.option_id == null && item.text === answer.text;
    if (!matches) return false;
    const original = journalAt(state, item.record_revision)[collection].find(candidate => candidate.id === record.id);
    return original?.revision === answer.revision;
  });
}

function matchesReadVersion(state, collection, record, item) {
  return canResolve(collection, record) && item.kind === 'resolve' && item.collection === collection && item.id === record.id &&
    item.record_revision === recordRevision(state, collection, record.id);
}
function hasReadReceipt(state, collection, record) {
  return state.replies.some(receipt => receipt.items.some(item => item.outcome === 'accepted' && matchesReadVersion(state, collection, record, item)));
}

function drawCard(parent, state, collection, record, place = 'attention', change = null) {
  const history = place === 'history';
  const type = recordType(collection, record);
  const fixed = place === 'attention';
  const card = add(parent, fixed ? 'article' : 'details', undefined, `jc-record jc-card ${type}${fixed ? ' jc-attention-card' : ''}`);
  card.dataset.record = record.id;
  card.dataset.collection = collection;
  recordDisclosure(card, state, collection, record, place, place === 'attention');
  const context = linkedContext(state, record);
  const summary = add(card, fixed ? 'div' : 'summary', undefined, 'jc-record-summary'), top = add(summary, 'div', undefined, 'jc-summary-top');
  const main = add(top, 'div', undefined, 'jc-summary-main'), title = add(main, 'div', undefined, 'jc-title-line');
  badge(title, types[collection] || types[type] || 'Note', type);
  add(title, 'span', recordTitle(collection, record), 'jc-record-title');
  const strip = add(top, 'div', undefined, 'jc-status-strip');
  if (!fixed || record.status !== 'open') stateBadge(strip, record.status, 'card', record, type);
  reminder(strip, record);
  let readControl;
  if (!history && canResolve(collection, record) && !hasReadReceipt(state, collection, record)) {
    readControl = replyControl(top, state, collection, record, place, 'resolve', undefined, 'jc-read-icon jc-close-icon');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true', focusable: 'false' })) icon.setAttribute(name, value);
    for (const d of ['M18 6 6 18', 'm6 6 12 12']) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d); icon.append(path);
    }
    readControl.append(icon);
  }
  const links = drawLinks(summary, state, record, context, place, collection);
  if (change) add(summary, 'span', changeLabel(change), 'jc-change');
  const body = add(card, 'div', undefined, 'jc-record-body');
  const description = displayText(collection === 'blockers' ? record.evidence : collection === 'cards' ? record.body : record.why, collection === 'blockers');
  const seen = new Set(description ? [description] : []);
  if (description) replyText(body, description, { tag: 'div', className: 'jc-content-box jc-primary', compact: true });
  cardContext(body, collection, record, history, seen);
  const nudge = displayText(record.nudge?.text);
  if (nudge && !seen.has(nudge)) { replyText(body, nudge, { className: `jc-nudge${record.nudge.priority === 'high' ? ' high' : ''}`, compact: true }); seen.add(nudge); }
  if (record.attention?.reason) detailField(body, 'Context', record.attention.reason, seen);
  const readResolution = record.resolution;
  const directRead = collection === 'cards' && ['qa', 'note', 'completion'].includes(record.type) && record.status === 'resolved' &&
    readResolution?.actor === 'user' && Number.isInteger(readResolution.record_revision) && readResolution.record_revision > 0 &&
    readResolution.source === `app:journal_mark_read:${record.id}:${readResolution.record_revision}`;
  if (record.resolution?.note && !directRead) detailField(body, `${record.resolution.actor === 'user' ? 'User' : 'Agent'} · Outcome`, record.resolution.note, seen);
  if (record.dismissal?.reason) detailField(body, `${record.dismissal.actor === 'user' ? 'User' : 'Agent'} · Outcome`, record.dismissal.reason, seen);
  if (record.user_answer && !hasAnswerReceipt(state, collection, record, history ? change?.replies || [] : null)) {
    const answer = record.user_answer;
    const row = responseRow(body, 'User answered');
    replyText(row, answer.text || record.options?.find(option => option.id === answer.option_id)?.label || 'Selected answer');
  }
  const replies = userReplies(body, state, collection, record, history ? change?.replies || [] : null);
  if (directRead && (!history || change?.before?.resolution?.source !== readResolution.source)) responseRow(body, 'User marked as read');
  if (record.attention?.state === 'later' && ['user', 'agent'].includes(record.attention.actor) &&
      (!history || JSON.stringify(change?.before?.attention) !== JSON.stringify(record.attention)) &&
      !replies.some(item => item.kind === 'defer' && item.outcome === 'accepted' && item.source === record.attention.source)) {
    const receipt = record.attention.actor === 'user' ? state.replies.find(receipt => receipt.source === record.attention.source &&
      receipt.items.some(item => item.collection === collection && item.id === record.id && item.kind === 'defer' && item.outcome === 'accepted')) : null;
    const caption = record.attention.actor === 'agent' ? 'Agent postponed' : receipt?.input_method === 'card' ? 'User selected'
      : !receipt || receipt.input_method === 'chat' ? 'Recorded from your message' : 'User chose';
    laterResponse(body, caption, receipt?.recorded_at ?? record.attention.recorded_at);
  }
  if (!history) {
    const actionable = hasChoices(collection, record);
    if (actionable) {
      if (collection === 'blockers') add(body, 'strong', 'Alternatives', 'jc-field-label');
      choices(body, state, collection, record, place);
    }
    replyActions(body, state, collection, record, place);
    if (place === 'cards') for (const draft of inspectReplies().retained) {
      if (draft.collection === collection && draft.id === record.id) drawStaleDraft(body, draft, false);
    }
  }
  const footer = add(body, 'div', undefined, 'jc-card-footer');
  const linkDestination = history ? footer : commentBox(footer, state, collection, record, place, true).querySelector('.jc-card-tools');
  const presentDisclosure = () => {
    const expanded = fixed || card.hasAttribute('open');
    if (readControl) readControl.hidden = !expanded;
    if (links) (expanded ? linkDestination : summary).append(links);
  };
  presentDisclosure();
  if (!fixed) card.addEventListener('toggle', presentDisclosure);
  if (history && !links) footer.remove();
}

function draftNeedsAttention(draft) {
  if (isRetiredBlockerAction(draft)) return false;
  const record = current[draft.collection]?.find(record => record.id === draft.id);
  return !record || needsAttention(record, draft.collection);
}
function retainedComment(draft) {
  return draft.kind === 'comment' && draft.collection !== 'requests' && !draftNeedsAttention(draft) &&
    recordRevision(current, draft.collection, draft.id) > draft.record_revision;
}
function acceptedReadDraftReceipt(draft) {
  if (draft.kind !== 'resolve' || draft.collection !== 'cards') return null;
  const original = journalAt(current, draft.record_revision).cards.find(record => record.id === draft.id);
  if (!canResolve(draft.collection, original)) return null;
  return current.replies.find(receipt => receipt.items.some(item => item.outcome === 'accepted' && item.kind === 'resolve' &&
    item.collection === draft.collection && item.id === draft.id && item.record_revision === draft.record_revision));
}
function retireReadDrafts() {
  const candidates = new Map([...drafts.drafts.values(), ...[...(drafts.actionCandidates?.values() ?? [])].flat()]
    .map(draft => [JSON.stringify([draftKey(draft), draft.token]), draft]));
  for (const draft of candidates.values()) {
    const receipt = acceptedReadDraftReceipt(draft);
    if (!receipt) continue;
    const key = draftKey(draft);
    if (draft.token === undefined) drafts.remove(key);
    else drafts.writeItem(key, null, draft.token, JSON.stringify(['read-receipt', receipt.id, key, draft.token]));
  }
  if (drafts.sharedConflict && drafts.sharedConflictTargets?.length) {
    drafts.sharedConflictTargets = drafts.sharedConflictTargets.filter(target => !acceptedReadDraftReceipt(target));
    drafts.sharedConflict = drafts.sharedConflictTargets.length > 0;
  }
}
function inspectReplies() {
  const inspected = drafts.inspect(current);
  const sharedConflict = !!drafts.sharedConflict && (!drafts.sharedConflictTargets?.length ||
    drafts.sharedConflictTargets.some(draftNeedsAttention));
  return { ...inspected, stale: inspected.stale.filter(draft => !acceptedReadDraftReceipt(draft) && draftNeedsAttention(draft)), sharedConflict,
    items: inspected.items.filter(item => !acceptedReadDraftReceipt(item) && !retainedComment(item)),
    retained: [...inspected.stale.filter(draft => !acceptedReadDraftReceipt(draft) && !draftNeedsAttention(draft)), ...inspected.items.filter(retainedComment)] };
}
function drawStaleDraft(parent, draft, pending = true) {
  const warning = add(parent, 'div', undefined, 'jc-warning');
  if (pending) {
    add(warning, 'strong', 'Review needed');
    add(warning, 'p', `${titleFor(draft)}: The choices changed. Review your draft or clear it before sending.`);
  } else add(warning, 'p', 'Saved before this card changed. This draft is kept here and will not be sent.');
  const original = journalAt(current, draft.record_revision)[draft.collection].find(record => record.id === draft.id);
  const value = ['answer', 'comment'].includes(draft.kind) ? draft.text || original?.options?.find(option => option.id === draft.option_id)?.label || draft.option_id
    : { defer: 'Later', resolve: draft.collection === 'blockers' ? 'Report completion' : 'Mark as read', acknowledge: 'Acknowledged' }[draft.kind];
  const saved = add(warning, 'div', undefined, 'jc-content-box');
  add(saved, 'strong', draft.kind === 'comment' ? 'Unsent comment' : draft.kind === 'answer' ? 'Unsent answer' : 'Unsent action');
  if (value) replyText(saved, value);
  if (pending) button(warning, 'Discard draft', () => { drafts.remove(draftKey(draft)); render(); });
}
function renderAttention() {
  const body = $('jc-attention-body'); body.replaceChildren();
  const items = attentionItems(current).filter(({ collection, record }) => !hasReadReceipt(current, collection, record) &&
    !(drafts.delivery?.status === 'waiting' && !drafts.receiptMismatch &&
      drafts.delivery.items.some(item => matchesReadVersion(current, collection, record, item))));
  $('jc-count').textContent = items.length;
  for (const { collection, record } of items) drawCard(body, current, collection, record);
  for (const draft of inspectReplies().stale) drawStaleDraft(body, draft);
  if (!body.childElementCount) add(body, 'p', 'No action needed.', 'jc-empty');
}

function requestMatches(record, filter = requestFilter) { return filter === 'all' || (filter === 'done' ? record.status === 'done' : !['done', 'cancelled'].includes(record.status)); }
function visibleRequestIds() {
  const records = new Map(current.requests.map(record => [record.id, record])), visible = new Set();
  for (const record of current.requests) {
    if (!requestMatches(record)) continue;
    let ancestor = record;
    const path = new Set();
    while (ancestor && !path.has(ancestor.id)) {
      path.add(ancestor.id); visible.add(ancestor.id); ancestor = records.get(ancestor.parent_id);
    }
  }
  return visible;
}
function drawRequest(parent, state, record, place, change = null, context = false) {
  const row = add(parent, 'div', undefined, 'jc-request'); row.dataset.record = record.id;
  if (place === 'requests' && record.id === revealedRequest) row.classList.add('jc-revealed');
  const details = add(row, 'details', undefined, 'jc-record');
  recordDisclosure(details, state, 'requests', record, place, place !== 'history' && (context || !['done', 'cancelled'].includes(record.status)));
  const summary = add(details, 'summary', undefined, 'jc-record-summary'); summary.tabIndex = 0;
  const top = add(summary, 'div', undefined, 'jc-summary-top');
  const title = add(top, 'div', undefined, 'jc-summary-main jc-title-line');
  add(title, 'span', record.title, 'jc-request-title jc-record-title');
  const linked = linkedContext(state, record, record.id);
  const strip = add(top, 'div', undefined, 'jc-status-strip');
  stateBadge(strip, record.status, 'request');
  const parentRequest = place === 'requests' && requestView === 'workspace' ? state.requests.find(item => item.id === record.parent_id) : null;
  const parentReference = parentRequest && safeActionUrl(inheritedWorkspace(state, parentRequest.id)?.url)?.href !==
    safeActionUrl(linked.workspace?.url)?.href;
  drawLinks(summary, state, record, linked, place, 'requests', parentReference ? { request_id: parentRequest.id } : record, parentReference ? 'Parent' : '');
  if (change) add(summary, 'span', changeLabel(change), 'jc-change');
  const body = add(details, 'div', undefined, 'jc-request-body');
  if (record.done_when) {
    const completion = add(body, 'div', undefined, 'jc-content-box jc-primary');
    add(completion, 'strong', 'Done when', 'jc-field-label');
    const list = add(completion, 'ul', undefined, 'jc-done-when');
    const conditions = Array.isArray(record.done_when) ? record.done_when : text(record.done_when).split(/\r?\n/);
    for (const condition of conditions) {
      const value = displayText(condition).replace(/^[-*•]\s+/, '').trim();
      if (value) replyText(list, value, { tag: 'li', compact: true });
    }
  }
  detailField(body, 'Evidence', record.evidence);
  detailField(body, 'Background', record.original_request || record.scope);
  userReplies(body, state, 'requests', record, place === 'history' ? change?.replies || [] : null);
  if (place !== 'history') commentBox(body, state, 'requests', record, place);
  return row;
}
function renderRequests() {
  const tree = $('jc-tree'); tree.replaceChildren();
  selectValue('jc-request-view', requestView);
  if (requestView === 'workspace') {
    const groups = workspaceGroups(current.requests), labels = new Map();
    for (const group of groups) labels.set(group.label, (labels.get(group.label) || 0) + 1);
    for (const group of groups) {
      const requests = group.requests.filter(record => requestMatches(record));
      if (!requests.length) continue;
      const section = add(tree, 'section', undefined, 'jc-workspace-group'); section.dataset.workspace = group.key;
      let label = group.label;
      if (group.url && labels.get(label) > 1) {
        const url = safeActionUrl(group.url); label += ` · ${url.host}${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`;
      }
      const heading = add(section, 'h3');
      if (!actionLink(heading, label, group.url, 'jc-workspace-heading')) heading.textContent = label;
      for (const record of requests) drawRequest(section, current, record, 'requests');
    }
    if (!tree.childElementCount) add(tree, 'p', 'No requests match this filter.', 'jc-empty');
    return;
  }
  const visible = visibleRequestIds();
  const children = new Map();
  for (const record of current.requests) {
    if (!visible.has(record.id)) continue;
    const key = visible.has(record.parent_id) ? record.parent_id : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(record);
  }
  const seen = new Set();
  function visit(record, parent) {
    if (seen.has(record.id) || !visible.has(record.id)) return;
    seen.add(record.id);
    const row = drawRequest(parent, current, record, 'requests', null, !requestMatches(record));
    if (!requestMatches(record)) row.classList.add('jc-context');
    const descendants = children.get(record.id) || [];
    if (descendants.length) {
      const branch = add(row.firstElementChild, 'div', undefined, 'jc-branch');
      for (const child of descendants) visit(child, branch);
    }
  }
  (children.get(null) || []).forEach(record => visit(record, tree));
  current.requests.forEach(record => visit(record, tree));
  if (!tree.childElementCount) add(tree, 'p', 'No requests match this filter.', 'jc-empty');
}

function cardMatches(record) {
  const suppliedAnswer = record.status === 'answered' && ['qa', 'note', 'completion'].includes(record.type);
  const closed = !suppliedAnswer && ['answered', 'resolved', 'superseded', 'dismissed', 'done', 'cancelled'].includes(record.status);
  return cardFilter === 'all' || (cardFilter === 'closed' ? closed
    : cardFilter === 'deferred' ? !closed && (record.status === 'deferred' || attentionState(record) === 'later')
    : cardFilter === 'open' ? record.status === 'open' || suppliedAnswer : record.status === cardFilter);
}
function renderCards() {
  const body = $('jc-cards-body'); body.replaceChildren(); selectValue('jc-card-filter', cardFilter);
  for (const collection of ['decisions', 'blockers', 'cards']) for (const record of current[collection]) {
    if (cardMatches(record)) drawCard(body, current, collection, record, 'cards');
  }
  if (!body.childElementCount) add(body, 'p', 'No cards match this filter.', 'jc-empty');
}
function changeLabel(change) {
  const labels = [];
  if (change.actions.includes('created')) labels.push('Created');
  if (change.actions.includes('status_changed') && change.before) {
    const before = statusPresentation(change.before.status, recordType(change.collection, change.before))[0];
    const after = statusPresentation(change.after?.status, recordType(change.collection, change.after || change.before))[0];
    labels.push(before === after ? 'Status changed' : `Status: ${before} → ${after}`);
  }
  if (change.actions.includes('updated') && !change.actions.includes('created') && !change.actions.includes('status_changed')) labels.push('Updated');
  if (change.actions.includes('commented')) labels.push('Commented');
  if (change.actions.includes('answered')) labels.push('Answer received');
  if (change.actions.includes('deferred')) labels.push('Later received');
  if (change.actions.includes('acknowledged')) labels.push('Acknowledgment received');
  if (change.actions.includes('resolution_reported')) labels.push(change.collection === 'blockers' ? 'Completion report received' : 'Read acknowledgment received');
  if (change.replies.some(reply => reply.outcome === 'stale')) labels.push('Review needed');
  return labels.join(' · ');
}
function renderHistory() {
  const turns = historyTurns(current);
  const selectedIndex = historyTurnId == null ? turns.length - 1 : turns.findIndex(turn => turn.id === historyTurnId);
  const index = Math.max(0, selectedIndex), revision = turns[index]?.revision ?? current.revision;
  const select = $('jc-turn'); select.replaceChildren();
  turns.forEach((turn, i) => {
    const state = journalAt(current, turn.revision), option = add(select, 'option', `Turn ${i + 1} · ${state.turn?.summary || 'Saved turn'}`);
    option.value = turn.id;
  });
  selectValue('jc-turn', turns[index]?.id);
  $('jc-prev').disabled = index <= 0; $('jc-next').disabled = index >= turns.length - 1;
  const state = journalAt(current, revision), body = $('jc-turn-body'); body.replaceChildren();
  add(body, 'p', state.turn?.summary || 'No saved turn yet.');
  if (state.turn?.end_reason) detailField(body, 'Result', { complete: 'Complete', answer_delivered: 'Answer delivered', decision: 'Decision needed', blocker: 'Blocked', background: 'Working', interrupted: 'Interrupted', user_paused: 'Paused' }[state.turn.end_reason] || 'Unknown');
  const requests = $('jc-history-requests'), cards = $('jc-history-cards'); requests.replaceChildren(); cards.replaceChildren();
  for (const change of turnChanges(state, turns[index]?.id)) {
    const record = change.after || change.before;
    if (!record) continue;
    if (change.collection === 'requests') drawRequest(requests, state, record, 'history', change);
    else drawCard(cards, state, change.collection, record, 'history', change);
  }
  requests.closest('section').hidden = !requests.childElementCount;
  cards.closest('section').hidden = !cards.childElementCount;
  $('jc-history-empty').hidden = !!(requests.childElementCount || cards.childElementCount);
}

function renderSummary() {
  $('jc-response').textContent = current.turn?.summary || 'No turn summary yet.';
  const goals = current.requests.filter(record => !record.parent_id);
  $('jc-goal-title').textContent = goals.length ? goals.map(record => record.title).join(' · ') : 'No requests yet.';
  const scopedRequests = current.requests.filter(record => !['cancelled', 'proposed', 'deferred'].includes(record.status));
  const scopedIds = new Set(scopedRequests.map(record => record.id));
  const openBlockers = current.blockers.filter(record => scopedIds.has(record.request_id) && record.status === 'open');
  const goalRequests = goals;
  const goalIds = new Set(goals.map(record => record.id));
  const requestsById = new Map(current.requests.map(record => [record.id, record]));
  const goalBlockers = openBlockers.filter(blocker => {
    let request = requestsById.get(blocker.request_id);
    const seen = new Set();
    while (request && !seen.has(request.id)) {
      if (goalIds.has(request.id)) return true;
      if (typeof request.scope_exclusion_source === 'string' && request.scope_exclusion_source.trim()) return false;
      seen.add(request.id); request = requestsById.get(request.parent_id);
    }
    return false;
  });
  let goal = ['Unknown', 'neutral'];
  if (goalRequests.length) {
    if (goalBlockers.length) goal = ['Blocked', 'blocked'];
    else if (goalRequests.every(record => record.status === 'cancelled')) goal = ['Cancelled', 'neutral'];
    else if (goalRequests.every(record => ['done', 'cancelled'].includes(record.status))) goal = ['Done', 'done'];
    else if (goalRequests.some(record => record.status === 'active')) goal = ['In progress', 'active'];
    else if (goalRequests.some(record => record.status === 'waiting')) goal = ['Waiting', 'waiting'];
    else if (goalRequests.some(record => record.status === 'deferred')) goal = statuses.deferred;
    else if (goalRequests.some(record => record.status === 'proposed')) goal = statuses.proposed;
    else goal = statuses[goalRequests[0].status] || goal;
  }
  $('jc-goal-status').textContent = goal[0]; $('jc-goal-status').className = `jc-badge ${goal[1]}`;
  const run = current.turn?.continuing_run;
  const activeIds = new Set(scopedRequests.filter(record => ['active', 'waiting'].includes(record.status)).map(record => record.id));
  const nonemptyText = value => typeof value === 'string' && value.trim().length > 0;
  const runEvidence = nonemptyText(run?.evidence) || (Array.isArray(run?.evidence) && run.evidence.length > 0 && run.evidence.every(nonemptyText));
  const running = run && nonemptyText(run.id) && run.status === 'running' && runEvidence &&
    nonemptyText(run.observed_turn_id) && run.observed_turn_id === current.turn?.id &&
    Array.isArray(run.request_ids) && run.request_ids.some(id => activeIds.has(id));
  const needsInput = current.decisions.some(record => scopedIds.has(record.request_id) && ['open', 'deferred'].includes(record.status) && record.required !== false && needsAttention(record)) || openBlockers.some(record => ['user', 'human'].includes(record.owner) && needsAttention(record, 'blockers'));
  let agent = ['Unknown', 'neutral'];
  const stop = current.turn?.end_reason ? evaluateStopAssessment(current, { turnId: current.turn.id }) : null;
  if (current.turn?.end_reason === 'user_paused') agent = ['Paused', 'neutral'];
  else if (current.turn?.end_reason === 'interrupted') agent = ['Interrupted', 'neutral'];
  else if (stop && !stop.allowed) agent = ['Work remains', 'blocked'];
  else if (needsInput) agent = ['Needs your input', 'pending'];
  else if (['complete', 'answer_delivered'].includes(current.turn?.end_reason)) {
    // A finished response is not proof that the user's requested work is done.
    const completion = evaluateCompletion(current, { turnId: current.turn.id });
    agent = completion.allowed ? ['Done', 'done'] : ['Work remains', 'blocked'];
  }
  else if (running) agent = ['Working', 'active'];
  $('jc-agent-status').textContent = agent[0]; $('jc-agent-status').className = `jc-badge ${agent[1]}`;
}

function renderQueuedComments() {
  const container = $('jc-queued-comments'); container.replaceChildren();
  const earlier = [...drafts.drafts.values()].filter(item => item.kind === 'comment' && !retainedComment(item) &&
    (!current[item.collection].some(record => record.id === item.id) ||
      recordRevision(current, item.collection, item.id) !== item.record_revision));
  container.hidden = !earlier.length;
  if (!earlier.length) return;
  add(container, 'h2', 'Unsent comments');
  for (const item of earlier) {
    const box = add(container, 'div', undefined, 'jc-content-box jc-input jc-queued-comment');
    const old = journalAt(current, item.record_revision)[item.collection].find(record => record.id === item.id);
    add(box, 'strong', titleFor(item));
    add(box, 'p', 'Written before this item changed.', 'jc-reply-context');
    if (old?.body || old?.why) replyText(box, displayText(old.body || old.why), { className: 'jc-reply-context', compact: true });
    const key = draftKey(item), inputId = `jc-queued-${encodeURIComponent(key)}`;
    const label = add(box, 'label', 'Comment'); label.htmlFor = inputId;
    const input = add(box, 'textarea'); input.id = inputId; input.rows = 2; input.maxLength = 4000;
    input.value = item.text; input.dataset.draftKey = key;
    input.setAttribute('aria-label', `Unsent comment · ${titleFor(item)}`);
    input.addEventListener('input', () => { if (input.isConnected) editDraft({ ...item, text: input.value }); });
    button(box, 'Discard draft', () => { drafts.remove(key); render(); });
  }
}

class ReplyRejectedError extends Error {}
async function sendReplyMessage(message) {
  const result = await extensions.message.send(message);
  if (result?.isError) throw new ReplyRejectedError('The chat did not accept this reply. Your reply is saved.');
}
function replyMessage(delivery, summary) {
  const envelope = { conversation_id: delivery.conversation_id, delivery_id: delivery.id, items: structuredClone(delivery.items) };
  return { role: 'user', content: [{ type: 'text', text: summary },
    { type: 'resource', resource: { uri: `request-journal://reply/${delivery.id}`, mimeType: 'application/json', text: JSON.stringify(envelope) } }],
  _meta: { 'openai/message': { target: 'active', send: true } } };
}
function sameKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function reviewedReply(delivery) {
  if (delivery.outbound !== undefined) {
    const message = delivery.outbound, [summary, resource] = Array.isArray(message?.content) ? message.content : [];
    const route = message?._meta?.['openai/message'];
    if (!sameKeys(message, ['role', 'content', '_meta']) || message.role !== 'user' || !Array.isArray(message.content) || message.content.length !== 2 ||
        !sameKeys(summary, ['type', 'text']) || summary.type !== 'text' || typeof summary.text !== 'string' || !summary.text.trim() ||
        !sameKeys(resource, ['type', 'resource']) || resource.type !== 'resource' ||
        !sameKeys(resource.resource, ['uri', 'mimeType', 'text']) ||
        resource.resource.uri !== `request-journal://reply/${delivery.id}` || resource.resource.mimeType !== 'application/json' ||
        typeof resource.resource.text !== 'string' || !sameKeys(message._meta, ['openai/message']) ||
        !sameKeys(route, ['target', 'send']) || route.target !== 'active' || route.send !== true) return null;
    try {
      const envelope = JSON.parse(resource.resource.text);
      if (!sameKeys(envelope, ['conversation_id', 'delivery_id', 'items']) || envelope.conversation_id !== delivery.conversation_id ||
          envelope.delivery_id !== delivery.id || JSON.stringify(envelope.items) !== JSON.stringify(delivery.items)) return null;
    } catch { return null; }
    return { message: structuredClone(message), restored: false };
  }
  const records = new Map();
  for (const item of delivery.items) {
    const original = current.history.find(event => event.revision === item.record_revision)?.changes
      .filter(change => change.collection === item.collection && change.id === item.id).at(-1)?.after;
    const record = journalAt(current, item.record_revision)[item.collection]?.find(record => record.id === item.id);
    if (!original || !record || JSON.stringify(record) !== JSON.stringify(original) ||
        (item.kind === 'answer' && item.option_id != null && !record.options?.some(option => option.id === item.option_id))) return null;
    records.set(draftKey(item), record);
  }
  return { message: replyMessage(delivery, formatReplyText(delivery.items, item => records.get(draftKey(item)))), restored: true };
}
function renderRetry() {
  let recovery = $('jc-retry');
  if (!recovery) {
    recovery = el('section', undefined, 'jc-content-box jc-draft-detail'); recovery.id = 'jc-retry';
    recovery.setAttribute('aria-label', 'Retry pending reply');
    root.insertBefore(recovery, root.querySelector('.jc-footer'));
  }
  const review = drafts.pendingReview({ refresh: false });
  recovery.hidden = !review || (review.status !== 'uncertain' && !retrying); recovery.replaceChildren();
  if (recovery.hidden) return;
  const original = reviewedReply(review.delivery);
  add(recovery, 'strong', 'Pending reply');
  add(recovery, 'p', 'The chat may already contain this reply. Retrying can add a duplicate copy to the chat.');
  if (review.status === 'uncertain' && review.attempt.status === 'reserved')
    add(recovery, 'p', 'An earlier retry has no confirmed result. The agent needs to check it before another send.', 'jc-reply-context');
  if (original) {
    const preview = add(recovery, 'div', original.message.content[0].text, 'jc-reply-context'); preview.id = 'jc-retry-preview';
    if (original.restored) add(recovery, 'p', 'Preview restored from the original reply records.', 'jc-reply-context');
  } else add(recovery, 'p', 'The original reply could not be verified. Retry stays blocked.', 'jc-reply-context');
  const control = button(recovery, 'Retry reply', () => {
    if (!control.isConnected || control.disabled || preparing || retrying) return;
    void retryReply(review, original);
  }); control.id = 'jc-retry-send';
  control.disabled = !original || !review.canRetry || !connected || !extensions.message || preparing || retrying ||
    !drafts.storageAvailable || drafts.coordinationUnavailable || drafts.receiptMismatch;
}

function renderReplyBar() {
  if (!drafts || !current) return;
  const { stale, invalid, items, sharedConflict } = inspectReplies();
  let status = items.length ? `${items.length} ${items.length === 1 ? 'reply' : 'replies'} ready` : '';
  if (invalid.length) status = 'Enter your answer under Other.';
  if (stale.length) status = 'The choices changed. Review your draft before sending.';
  if (!connected || !extensions.message) status = 'This host cannot send replies. Reply in the chat instead.';
  if (preparing) status = 'Checking the latest records…';
  if (drafts.delivery) status = drafts.delivery.status === 'sending' ? 'Sending your reply…' : drafts.delivery.status === 'uncertain' ? 'Delivery is unconfirmed. Review the original reply before retrying.' : 'Sent to the chat. Waiting for the agent to record your reply.';
  if (drafts.delivery?.status === 'uncertain' && drafts.deliveryAttempt?.status === 'reserved')
    status = 'An earlier retry has no confirmed result. Ask the agent to check it.';
  if (drafts.receiptMismatch) status = 'The saved reply differs from what you sent. Ask the agent to check it.';
  if (sharedConflict) status = 'A reply changed in another view. Review the current selection, then choose again.';
  if (drafts.coordinationUnavailable) status = 'This view cannot coordinate replies with other open views. Reply in the chat instead.';
  $('jc-draft').textContent = status;
  $('jc-send').disabled = !connected || !extensions.message || preparing || !!drafts.delivery || !drafts.storageAvailable || drafts.coordinationUnavailable || sharedConflict || stale.length > 0 || invalid.length > 0 || items.length === 0;
  for (const control of root.querySelectorAll('.jc-read-icon'))
    control.disabled = !connected || markingRead.has(control.dataset.readKey);
  $('jc-storage').hidden = drafts.storageAvailable;
  const storageReason = { access: 'Draft storage cannot be accessed.', data: 'Saved draft data is invalid.', write: 'Draft storage could not be written.' }[drafts.storageFailure] || '';
  $('jc-storage').textContent = `${storageReason} Drafts cannot be saved and may be lost when you close this view. Send reply is disabled to avoid duplicate delivery. Reply in the chat instead.`.trim();
  renderRetry();
}

function render() {
  for (const control of root.querySelectorAll('[data-tab]')) {
    const selected = control.dataset.tab === tab;
    control.setAttribute('aria-selected', String(selected)); control.tabIndex = selected ? 0 : -1;
    $(`jc-${control.dataset.tab}`).hidden = !selected;
  }
  for (const control of root.querySelectorAll('[data-filter]')) control.setAttribute('aria-pressed', String(control.dataset.filter === requestFilter));
  if (!current) return;
  const active = document.activeElement;
  const focus = active?.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  for (const details of root.querySelectorAll('details[data-disclosure]')) {
    const open = details.hasAttribute('open');
    if (open !== (details.dataset.disclosureOpen === 'true')) disclosures.set(details.dataset.disclosure, open);
  }
  renderSummary(); renderAttention(); renderRequests(); renderCards(); renderHistory(); renderQueuedComments(); renderReplyBar();
  if (focus) {
    const control = $(focus.id);
    if (control) { control.focus(); if (typeof control.setSelectionRange === 'function' && focus.start != null) control.setSelectionRange(focus.start, focus.end); }
  }
}

function accept(result) {
  if (result?.isError) throw new Error(result.content?.find(block => block.type === 'text')?.text || 'Could not read the saved journal.');
  const journal = result?.structuredContent?.journal;
  if (!journal) throw new Error('No journal data was returned.');
  if (current && journal.conversation_id !== current.conversation_id) throw new Error('Received a different conversation. The current journal was kept.');
  if (current && journal.revision < current.revision) return false;
  const normalized = normalizeJournal(journal);
  if (current && normalized.revision === current.revision && JSON.stringify(normalized) === JSON.stringify(current)) {
    const presentation = () => JSON.stringify([[...drafts.drafts], drafts.delivery, [...(drafts.actionConflicts ?? [])]]);
    const before = presentation();
    drafts.reconcile(current);
    retireReadDrafts();
    clearConfirmedNotice();
    if (before !== presentation()) render();
    else renderReplyBar();
    return true;
  }
  current = normalized;
  if (!drafts) {
    let storage;
    try { storage = window.localStorage; } catch { storage = null; }
    drafts = new ReplyDrafts(storage, current.conversation_id);
  }
  drafts.reconcile(current);
  retireReadDrafts();
  clearConfirmedNotice(); render();
  return true;
}
async function readLatest() {
  if (!current) throw new Error('The journal has not loaded yet.');
  if (reading) return reading;
  reading = (async () => {
    const result = await app.callServerTool({ name: 'journal_read', arguments: { conversation_id: current.conversation_id } });
    if (!accept(result)) throw new Error('Could not confirm the latest records.');
  })();
  try { await reading; } finally { reading = null; }
}
async function refresh() {
  if (!current || preparing) return;
  try { await readLatest(); }
  catch (error) { notice(`Could not refresh. Showing the last saved version. ${error.message}`, true, 'read'); }
}

async function retryReply(review, original) {
  if (preparing || retrying || !original || !connected || !extensions.message) return;
  const retryNotice = connectionNotice;
  preparing = true; retrying = true; renderReplyBar();
  let unverifiable = false, rejected = false;
  try {
    const result = await drafts.retryDelivery(review, {
      getLatestJournal: async () => { await readLatest(); return current; },
      transmit: async delivery => {
        const checked = reviewedReply(delivery);
        if (!checked || JSON.stringify(checked.message) !== JSON.stringify(original.message)) {
          unverifiable = true; throw new Error('The original reply could not be verified.');
        }
        try { await sendReplyMessage(structuredClone(original.message)); }
        catch (error) { rejected = error instanceof ReplyRejectedError; throw error; }
      },
    });
    const live = drafts.pendingReview();
    if (['sent', 'uncertain'].includes(result.status) &&
        (!live || live.delivery.id !== result.deliveryId || live.generation !== result.generation)) return;
    if (result.status === 'sent' && connectionNotice === retryNotice &&
        retryNotice.kind === 'delivery' && retryNotice.deliveryId === result.deliveryId) notice('');
    const message = {
      uncertain: unverifiable ? 'The original reply could not be verified. Retry stays blocked.'
        : rejected ? 'The chat did not accept this reply. Your reply is saved.' : 'Delivery is unconfirmed. Review the original reply before retrying again.',
      changed: 'The pending reply changed in another view. Review it before retrying again.',
      mismatch: 'The saved reply differs from the original reply. Ask the agent to check it.',
      read_failed: 'Could not check the latest saved reply. Retry was not sent.',
      storage_failed: 'Could not save the retry attempt. Retry was not sent.',
      coordination_failed: 'Could not coordinate this retry with other views. Retry was not sent.',
    }[result.status];
    if (message) notice(message, true, 'delivery', review.delivery.id);
    if (result.status === 'settled') clearConfirmedNotice();
  } catch (error) { notice(`Could not retry your reply. ${error.message}`, true, 'delivery', review.delivery.id); }
  finally { preparing = false; retrying = false; render(); }
}

async function markRead(target) {
  const key = JSON.stringify([target.collection, target.id]);
  if (!connected || markingRead.has(key)) return;
  const record = current?.[target.collection]?.find(record => record.id === target.id);
  if (!canResolve(target.collection, record) || hasReadReceipt(current, target.collection, record) ||
      recordRevision(current, target.collection, target.id) !== target.record_revision) {
    render(); notice('This card changed. Review it before marking it as read.', true, 'mark-read', key); return;
  }
  markingRead.add(key); renderReplyBar();
  const previousNotice = connectionNotice;
  try {
    const result = await app.callServerTool({ name: 'journal_mark_read', arguments: {
      conversation_id: current.conversation_id, card_id: target.id, record_revision: target.record_revision,
    } });
    const saved = result?.structuredContent?.journal?.cards?.find(card => card.id === target.id);
    if (result?.isError || saved?.status !== 'resolved' || saved.resolution?.actor !== 'user' ||
        saved.resolution.source !== `app:journal_mark_read:${target.id}:${target.record_revision}` ||
        saved.resolution.record_revision !== target.record_revision) throw new Error('Read save was not confirmed.');
    accept(result);
    if (connectionNotice === previousNotice && previousNotice.kind === 'mark-read' && previousNotice.deliveryId === key) notice('');
  } catch {
    notice('Could not mark this card as read. Try × again.', true, 'mark-read', key);
  } finally { markingRead.delete(key); render(); }
}

async function sendReply() {
  if ($('jc-send').disabled || preparing || drafts.delivery) return;
  // Bind this gesture to the meaningful batch visible before any asynchronous
  // read can import another surface's unsent choice or comment.
  const intendedItems = structuredClone(inspectReplies().items);
  preparing = true; renderReplyBar();
  try {
    await readLatest();
    const inspected = inspectReplies();
    const remainingIntended = intendedItems.filter(item => !acceptedReadDraftReceipt(item));
    if (JSON.stringify(inspected.items) !== JSON.stringify(remainingIntended)) {
      render();
      notice('A reply changed in another view. Review the updated reply, then send again.', true);
      return;
    }
    if (inspected.sharedConflict || inspected.stale.length || inspected.invalid.length || !inspected.items.length) {
      render(); return;
    }
    const cryptoApi = window.crypto || globalThis.crypto;
    if (!cryptoApi?.randomUUID) throw new Error('Could not create a reply ID.');
    const deliveryId = cryptoApi.randomUUID();
    const summary = formatReplyText(inspected.items, item =>
      journalAt(current, item.record_revision)[item.collection].find(record => record.id === item.id));
    const outbound = replyMessage({ conversation_id: current.conversation_id, id: deliveryId, items: inspected.items }, summary);
    if (!await drafts.stageAsync(deliveryId, inspected.items, outbound)) {
      render(); return;
    }
    renderReplyBar();
    try {
      await sendReplyMessage(outbound);
      drafts.deliveryStatus('waiting', deliveryId);
    } catch (error) {
      if (drafts.deliveryStatus('uncertain', deliveryId)) notice(error instanceof ReplyRejectedError ? error.message
        : 'Delivery is unconfirmed. Review the original reply before retrying.', true, 'delivery', deliveryId);
    }
  } catch (error) { notice(`Could not send your reply. ${error.message}`, true); }
  finally { preparing = false; render(); }
}

for (const control of root.querySelectorAll('[data-tab]')) {
  control.addEventListener('click', () => { tab = control.dataset.tab; render(); });
  control.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...root.querySelectorAll('[data-tab]')], index = tabs.indexOf(control);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tab = tabs[next].dataset.tab; render(); tabs[next].focus();
  });
}
for (const control of root.querySelectorAll('[data-filter]')) control.addEventListener('click', () => { requestFilter = control.dataset.filter; render(); });
$('jc-turn').addEventListener('change', () => { historyTurnId = $('jc-turn').value; render(); });
for (const [id, delta] of [['jc-prev', -1], ['jc-next', 1]]) $(id).addEventListener('click', () => {
  const turns = historyTurns(current), index = historyTurnId == null ? turns.length - 1 : turns.findIndex(turn => turn.id === historyTurnId);
  const turn = turns[index + delta]; if (!turn) return;
  historyTurnId = turn.id; render();
});
$('jc-request-view').addEventListener('change', () => { requestView = $('jc-request-view').value; render(); });
$('jc-card-filter').addEventListener('change', () => { cardFilter = $('jc-card-filter').value; render(); });
$('jc-send').addEventListener('click', () => sendReply());
app.ontoolresult = result => { try { accept(result); } catch (error) { notice(error.message, true, 'read'); } };
app.onteardown = async () => { clearInterval(poll); drafts?.persist(); return {}; };
(async () => {
  await app.connect(); connected = true; applyHostContext(app.getHostContext?.()); render(); poll = setInterval(refresh, 2500);
})().catch(error => { notice(`Could not connect to the chat app. ${error.message}`, true); renderReplyBar(); });
window.addEventListener('pagehide', () => { clearInterval(poll); drafts?.persist(); }, { once: true });
