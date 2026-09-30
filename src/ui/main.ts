// Chat + settings UI running in the plugin iframe. All dynamic text goes
// through textContent – model output is never interpreted as HTML.

import type { DiffRow } from '../plugin/proposal.ts';
import type { Settings } from '../plugin/settings.ts';
import type { MessageKey } from '../shared/i18n.ts';
import type { ChatResponse, ProposalItemView, ProposalView, SettingsResponse } from '../shared/protocol.ts';
import type { PluginIframeApi } from '../types/plugin-api.ts';
import { send } from './bridge.ts';
import { initLanguage, t, translateStatic } from './i18n.ts';
import { icon, type IconName } from './icons.ts';

declare global {
  interface Window {
    /** Injected by Super Productivity into the plugin iframe. */
    PluginAPI?: PluginIframeApi;
  }
}

const sessionId = `s${String(Date.now())}`;

const $ = <T extends HTMLElement = HTMLElement>(
  id: string,
  type: new () => T = HTMLElement as new () => T,
): T => {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} missing`);
  return el;
};

type Child = Node | string | null | undefined | false;

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: Child[]
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const c of children) if (c) el.append(c);
  return el;
};

const badge = (iconName: IconName | null, text: string, variant = 'badge-outline'): HTMLElement =>
  h('span', `badge ${variant}`, iconName && icon(iconName), text);

const minutes = (count: number): string => t('PROPOSAL.MINUTES', { count });
const markNew = (name: string, isNew: boolean | undefined): string => (isNew ? t('PROPOSAL.NEW', { name }) : name);

const FIELD_LABELS: Record<DiffRow[0], MessageKey> = {
  title: 'PROPOSAL.FIELD.TITLE',
  notes: 'PROPOSAL.FIELD.NOTES',
  estimate: 'PROPOSAL.FIELD.ESTIMATE',
  due: 'PROPOSAL.FIELD.DUE',
  status: 'PROPOSAL.FIELD.STATUS',
  project: 'PROPOSAL.FIELD.PROJECT',
  tags: 'PROPOSAL.FIELD.TAGS',
};

/** Diff values are data (see DiffRow); format them for display. */
const formatDiffValue = (field: DiffRow[0], value: string): string => {
  if (value === '–' || value === '') return value;
  if (field === 'estimate') return minutes(Number(value));
  if (field === 'status') return t(value === 'done' ? 'PROPOSAL.STATUS_DONE' : 'PROPOSAL.STATUS_OPEN');
  return value;
};

// Static icon placeholders in index.html: <span data-icon="name">. Elements
// with their own class (e.g. .logo) keep their box; bare spans are replaced.
const renderStaticIcons = (): void => {
  document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const svg = icon(el.dataset.icon as IconName);
    if (el.classList.length) el.replaceChildren(svg);
    else el.replaceWith(svg);
  });
};

// --- chat -------------------------------------------------------------------

const log = $('log', HTMLDivElement);
const empty = $('empty');
const input = $('input', HTMLTextAreaElement);
const sendBtn = $('send', HTMLButtonElement);

const appendToLog = (el: HTMLElement): HTMLElement => {
  empty.hidden = true;
  log.append(el);
  log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
  return el;
};

const addMessage = (role: 'user' | 'assistant' | 'error', text: string, footer?: string): HTMLElement => {
  const variant = role === 'user' ? 'bubble-default' : role === 'error' ? 'bubble-destructive' : 'bubble-muted';
  const content = h('div', 'message-content', h('div', `bubble ${variant}`, text));
  if (footer) content.append(h('div', 'message-footer', footer));
  const msg = h('div', 'message');
  msg.dataset.align = role === 'user' ? 'end' : 'start';
  if (role !== 'user') msg.append(h('div', 'message-avatar', icon(role === 'error' ? 'circle-alert' : 'bot')));
  msg.append(content);
  return appendToLog(msg);
};

const createItemBody = (item: ProposalItemView): HTMLElement => {
  const body = h('div', 'item-body', h('div', 'item-title', icon(item.kind === 'create' ? 'plus' : 'pencil'), item.title));
  const badges = h('div', 'item-badges');
  if (item.parent) badges.append(badge(null, t('PROPOSAL.SUBTASK_OF', { title: item.parent }), 'badge-secondary'));
  if (item.project) badges.append(badge('folder', markNew(item.project, item.projectIsNew)));
  if (item.dueDay) badges.append(badge('calendar', item.dueDay));
  if (item.estimateMin) badges.append(badge('clock', minutes(item.estimateMin)));
  for (const tag of item.tags ?? []) badges.append(badge('tag', markNew(tag.name, tag.isNew)));
  if (badges.childElementCount) body.append(badges);

  if (item.kind === 'create') {
    if (item.notes) body.append(h('div', 'item-notes', item.notes));
    if (item.subtasks?.length) {
      const subs = h('div', 'item-subs');
      for (const s of item.subtasks) {
        const extra = [s.dueDay, s.estimateMin ? minutes(s.estimateMin) : ''].filter(Boolean).join(' · ');
        subs.append(h('div', undefined, s.title, extra && h('span', 'muted', ` · ${extra}`)));
      }
      body.append(subs);
    }
  } else if (item.diff?.length) {
    const dl = h('dl', 'item-diff');
    for (const [field, from, to] of item.diff) {
      let after = formatDiffValue(field, to);
      if (field === 'tags' && item.newTags?.length) {
        after = [after, ...item.newTags.map((name) => markNew(name, true))].filter(Boolean).join(', ');
      }
      dl.append(
        h('dt', undefined, t(FIELD_LABELS[field])),
        h('dd', undefined, h('del', undefined, formatDiffValue(field, from)), ' → ', after),
      );
    }
    body.append(dl);
  }
  return body;
};

const renderProposal = (proposal: ProposalView): void => {
  const count = proposal.items.length;
  const description = h('div', 'card-description', t('PROPOSAL.DESCRIPTION'));
  const card = h(
    'div',
    'card proposal',
    h(
      'div',
      'card-header',
      h('div', 'card-title', count === 1 ? t('PROPOSAL.TITLE_ONE') : t('PROPOSAL.TITLE_OTHER', { count })),
      description,
    ),
  );

  const checkboxes: HTMLInputElement[] = [];
  const list = h('div', 'proposal-items');
  for (const item of proposal.items) {
    const checkbox = h('input', 'checkbox');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.index = String(item.index);
    checkboxes.push(checkbox);
    list.append(h('label', 'proposal-item', checkbox, createItemBody(item)));
  }
  card.append(h('div', 'card-content', list));

  const applyLabel = h('span');
  const applyBtn = h('button', 'btn btn-default btn-sm', icon('check'), applyLabel);
  applyBtn.type = 'button';
  const discardBtn = h('button', 'btn btn-outline btn-sm', icon('x'), t('PROPOSAL.DISCARD'));
  discardBtn.type = 'button';
  const footer = h('div', 'card-footer border-t', applyBtn, discardBtn);
  card.append(footer);

  const selected = (): number[] => checkboxes.filter((c) => c.checked).map((c) => Number(c.dataset.index));
  const updateApplyLabel = (): void => {
    const n = selected().length;
    applyLabel.textContent = n === count ? t('PROPOSAL.APPLY') : t('PROPOSAL.APPLY_SOME', { selected: n, total: count });
    applyBtn.disabled = n === 0;
  };
  checkboxes.forEach((c) => {
    c.addEventListener('change', updateApplyLabel);
  });
  updateApplyLabel();

  const finish = (...status: HTMLElement[]): void => {
    checkboxes.forEach((c) => {
      c.disabled = true;
    });
    description.remove();
    footer.replaceChildren(h('div', 'proposal-status', ...status));
  };

  applyBtn.addEventListener('click', () => {
    applyBtn.disabled = true;
    discardBtn.disabled = true;
    applyBtn.replaceChildren(icon('loader-circle', 'spinner'), applyLabel);
    applyLabel.textContent = t('PROPOSAL.APPLYING');
    void send({ type: 'apply', sessionId, proposalId: proposal.id, selected: selected() }).then((res) => {
      if (!res.ok) {
        discardBtn.disabled = false;
        applyBtn.replaceChildren(icon('check'), applyLabel);
        updateApplyLabel();
        description.textContent = t('PROPOSAL.ERROR', { error: res.error });
        return;
      }
      const failed = res.data.filter((r) => !r.ok);
      const done = res.data.length - failed.length;
      finish(
        ...(done ? [badge('check', t('PROPOSAL.APPLIED', { count: done }), 'badge-secondary')] : []),
        ...failed.map((f) => badge('x', `${f.title}: ${f.error ?? ''}`, 'badge-destructive')),
      );
    });
  });

  discardBtn.addEventListener('click', () => {
    void send({ type: 'discard', sessionId, proposalId: proposal.id });
    finish(badge('x', t('PROPOSAL.DISCARDED')));
  });

  appendToLog(card);
};

let typing: HTMLElement | null = null;
const setBusy = (busy: boolean): void => {
  sendBtn.disabled = busy;
  input.disabled = busy;
  typing?.remove();
  typing = busy
    ? appendToLog(
        h(
          'div',
          'message',
          h('div', 'message-avatar', icon('bot')),
          h('div', 'typing', icon('loader-circle', 'spinner'), t('UI.THINKING')),
        ),
      )
    : null;
};

const submit = async (): Promise<void> => {
  const text = input.value.trim();
  if (!text || sendBtn.disabled) return;
  input.value = '';
  addMessage('user', text);
  setBusy(true);
  try {
    const res = await send({ type: 'chat', sessionId, text });
    setBusy(false);
    if (!res.ok) {
      addMessage('error', res.error);
      return;
    }
    const data: ChatResponse = res.data;
    const tools = data.toolCalls.length ? t('UI.TOOLS_USED', { tools: [...new Set(data.toolCalls)].join(', ') }) : undefined;
    addMessage('assistant', data.reply || t('UI.NO_REPLY'), tools);
    if (data.proposal) renderProposal(data.proposal);
  } catch (e) {
    setBusy(false);
    addMessage('error', e instanceof Error ? e.message : String(e));
  } finally {
    input.focus();
  }
};

$('composer', HTMLFormElement).addEventListener('submit', (e) => {
  e.preventDefault();
  void submit();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
  }
});
document.querySelectorAll<HTMLButtonElement>('#examples button').forEach((btn) => {
  btn.addEventListener('click', () => {
    input.value = t(btn.dataset.prompt as MessageKey);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
});
$('reset').addEventListener('click', () => {
  void send({ type: 'reset', sessionId });
  log.replaceChildren(empty);
  empty.hidden = false;
  input.focus();
});

// --- settings ---------------------------------------------------------------

const form = $('settings-form', HTMLFormElement);
const field = (name: keyof Settings | 'apiKey'): HTMLInputElement | HTMLTextAreaElement => {
  const el = form.elements.namedItem(name);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error(`field ${name} missing`);
  return el;
};
const settingsStatus = $('settings-status');
const clearKey = $('clear-key', HTMLInputElement);

const fillForm = ({ settings, hasApiKey }: SettingsResponse): void => {
  for (const [key, value] of Object.entries(settings)) field(key as keyof Settings).value = String(value);
  const apiKey = field('apiKey');
  apiKey.value = '';
  apiKey.placeholder = hasApiKey ? t('SETTINGS.API_KEY_SAVED') : t('SETTINGS.API_KEY_NONE');
  $('no-model-hint').hidden = Boolean(settings.chatModel);
};

const loadSettings = async (): Promise<void> => {
  const res = await send({ type: 'getSettings' });
  if (res.ok) fillForm(res.data);
  else settingsStatus.textContent = res.error;
};

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const settings: Partial<Settings> = {
    baseUrl: field('baseUrl').value,
    chatModel: field('chatModel').value,
    embeddingModel: field('embeddingModel').value,
    rerankModel: field('rerankModel').value,
    temperature: Number(field('temperature').value),
    maxToolRounds: Number(field('maxToolRounds').value),
    requestTimeoutMs: Number(field('requestTimeoutMs').value),
    customInstructions: field('customInstructions').value,
  };
  settingsStatus.textContent = t('SETTINGS.SAVING');
  void send({
    type: 'saveSettings',
    settings,
    apiKey: clearKey.checked ? '' : field('apiKey').value.trim() || undefined,
  }).then((res) => {
    if (!res.ok) {
      settingsStatus.textContent = t('SETTINGS.ERROR', { error: res.error });
      return;
    }
    clearKey.checked = false;
    fillForm(res.data);
    settingsStatus.textContent = t('SETTINGS.SAVED');
  });
});

$('load-models').addEventListener('click', () => {
  settingsStatus.textContent = t('SETTINGS.CONNECTING');
  void send({ type: 'listModels' }).then((res) => {
    if (!res.ok) {
      settingsStatus.textContent = t('SETTINGS.CONNECTION_FAILED', { error: res.error });
      return;
    }
    $('models').replaceChildren(
      ...res.data.map((id) => {
        const option = h('option');
        option.value = id;
        return option;
      }),
    );
    settingsStatus.textContent = t('SETTINGS.CONNECTION_OK', { count: res.data.length });
  });
});

// --- tabs -------------------------------------------------------------------

const showTab = (tab: 'chat' | 'settings'): void => {
  $('view-chat').hidden = tab !== 'chat';
  $('view-settings').hidden = tab !== 'settings';
  $('tab-chat').setAttribute('aria-selected', String(tab === 'chat'));
  $('tab-settings').setAttribute('aria-selected', String(tab === 'settings'));
  if (tab === 'settings') void loadSettings();
};
$('tab-chat').addEventListener('click', () => {
  showTab('chat');
});
$('tab-settings').addEventListener('click', () => {
  showTab('settings');
});
$('no-model-link').addEventListener('click', () => {
  showTab('settings');
});

// --- startup ----------------------------------------------------------------

const start = async (): Promise<void> => {
  await initLanguage(window.PluginAPI);
  translateStatic(document);
  renderStaticIcons();
  input.focus();
  // Point first-time users to the settings.
  const res = await send({ type: 'getSettings' });
  if (res.ok) $('no-model-hint').hidden = Boolean(res.data.settings.chatModel);
};
void start();
