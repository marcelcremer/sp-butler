// Chat + settings UI running in the plugin iframe. All output goes through
// textContent – model output is never interpreted as HTML.

import type { ChatResponse, ProposalItemView, ProposalView, SettingsResponse } from '../shared/protocol.ts';
import type { Settings } from '../plugin/settings.ts';
import { send } from './bridge.ts';

const sessionId = `s${String(Date.now())}`;

const $ = <T extends HTMLElement = HTMLElement>(
  id: string,
  type: new () => T = HTMLElement as new () => T,
): T => {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} missing`);
  return el;
};

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string } = {},
  ...children: (Node | null)[]
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (props.className) el.className = props.className;
  if (props.text !== undefined) el.textContent = props.text;
  for (const c of children) if (c) el.append(c);
  return el;
};

// --- chat -------------------------------------------------------------------

const log = $('log', HTMLDivElement);
const input = $('input', HTMLTextAreaElement);
const sendBtn = $('send', HTMLButtonElement);

const scrollDown = (): void => {
  log.scrollTop = log.scrollHeight;
};

const addBubble = (role: 'user' | 'assistant' | 'error', text: string, meta?: string): HTMLElement => {
  const bubble = h('div', { className: `msg msg-${role}` }, h('div', { className: 'msg-text', text }));
  if (meta) bubble.append(h('div', { className: 'msg-meta', text: meta }));
  log.append(bubble);
  scrollDown();
  return bubble;
};

const describeCreate = (item: ProposalItemView): string => {
  const parts: string[] = [];
  if (item.parent) parts.push(`Subtask von „${item.parent}“`);
  if (item.project) parts.push(`📁 ${item.project}`);
  if (item.dueDay) parts.push(`📅 ${item.dueDay}`);
  if (item.estimateMin) parts.push(`⏱ ${String(item.estimateMin)} min`);
  if (item.tags?.length) parts.push(`🏷 ${item.tags.join(', ')}`);
  return parts.join('  ·  ');
};

const renderItem = (item: ProposalItemView): HTMLElement => {
  const checkbox = h('input');
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  checkbox.dataset.index = String(item.index);

  const body = h(
    'div',
    { className: 'item-body' },
    h('div', { className: 'item-title', text: `${item.kind === 'create' ? '＋' : '✎'} ${item.title}` }),
  );
  if (item.kind === 'create') {
    const meta = describeCreate(item);
    if (meta) body.append(h('div', { className: 'item-meta', text: meta }));
    if (item.notes) body.append(h('div', { className: 'item-notes', text: item.notes }));
    if (item.subtasks?.length) {
      const ul = h('ul', { className: 'item-subs' });
      for (const s of item.subtasks) {
        const extra = [s.dueDay, s.estimateMin ? `${String(s.estimateMin)} min` : ''].filter(Boolean).join(', ');
        ul.append(h('li', { text: extra ? `${s.title} (${extra})` : s.title }));
      }
      body.append(ul);
    }
  } else {
    if (item.project) body.append(h('div', { className: 'item-meta', text: `📁 ${item.project}` }));
    for (const [field, from, to] of item.diff ?? []) {
      body.append(h('div', { className: 'item-diff', text: `${field}: ${from} → ${to}` }));
    }
  }
  const label = h('label', { className: 'item' }, checkbox, body);
  return label;
};

const renderProposal = (proposal: ProposalView): void => {
  const card = h('div', { className: 'card proposal' });
  card.append(h('div', { className: 'proposal-head', text: `Vorschlag – ${String(proposal.items.length)} Änderung(en)` }));
  const list = h('div', { className: 'items' });
  list.append(...proposal.items.map(renderItem));
  card.append(list);

  const applyBtn = h('button', { className: 'btn-primary', text: 'Übernehmen' });
  const discardBtn = h('button', { text: 'Verwerfen' });
  const status = h('div', { className: 'proposal-status' });
  card.append(h('div', { className: 'actions' }, applyBtn, discardBtn), status);

  const finish = (text: string): void => {
    applyBtn.remove();
    discardBtn.remove();
    list.querySelectorAll('input').forEach((c) => {
      c.disabled = true;
    });
    status.textContent = text;
  };

  applyBtn.addEventListener('click', () => {
    const selected = [...list.querySelectorAll<HTMLInputElement>('input:checked')].map((c) => Number(c.dataset.index));
    if (!selected.length) {
      status.textContent = 'Nichts ausgewählt.';
      return;
    }
    applyBtn.disabled = true;
    discardBtn.disabled = true;
    status.textContent = 'Wird ausgeführt …';
    void send({ type: 'apply', sessionId, proposalId: proposal.id, selected }).then((res) => {
      if (!res.ok) {
        status.textContent = `Fehler: ${res.error}`;
        applyBtn.disabled = false;
        discardBtn.disabled = false;
        return;
      }
      const failed = res.data.filter((r) => !r.ok);
      finish(
        failed.length
          ? `✓ ${String(res.data.length - failed.length)} ausgeführt, ✗ ${failed.map((f) => `${f.title}: ${f.error ?? ''}`).join('; ')}`
          : `✓ ${String(res.data.length)} ausgeführt`,
      );
    });
  });

  discardBtn.addEventListener('click', () => {
    void send({ type: 'discard', sessionId, proposalId: proposal.id });
    finish('Verworfen.');
  });

  log.append(card);
  scrollDown();
};

const setBusy = (busy: boolean): void => {
  sendBtn.disabled = busy;
  input.disabled = busy;
  $('typing').hidden = !busy;
};

const submit = async (): Promise<void> => {
  const text = input.value.trim();
  if (!text || sendBtn.disabled) return;
  input.value = '';
  $('examples').hidden = true;
  addBubble('user', text);
  setBusy(true);
  try {
    const res = await send({ type: 'chat', sessionId, text });
    if (!res.ok) {
      addBubble('error', res.error);
      return;
    }
    const data: ChatResponse = res.data;
    const tools = data.toolCalls.length ? `Tools: ${[...new Set(data.toolCalls)].join(', ')}` : undefined;
    addBubble('assistant', data.reply || '(keine Antwort)', tools);
    if (data.proposal) renderProposal(data.proposal);
  } catch (e) {
    addBubble('error', e instanceof Error ? e.message : String(e));
  } finally {
    setBusy(false);
    input.focus();
  }
};

sendBtn.addEventListener('click', () => void submit());
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
  }
});
document.querySelectorAll<HTMLButtonElement>('#examples button').forEach((btn) => {
  btn.addEventListener('click', () => {
    input.value = btn.dataset.text ?? btn.textContent;
    input.focus();
  });
});
$('reset').addEventListener('click', () => {
  void send({ type: 'reset', sessionId });
  log.replaceChildren();
  $('examples').hidden = false;
});

// --- settings ---------------------------------------------------------------

const form = $('settings-form', HTMLFormElement);
const field = (name: keyof Settings | 'apiKey'): HTMLInputElement | HTMLTextAreaElement => {
  const el = form.elements.namedItem(name);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error(`field ${name} missing`);
  return el;
};
const settingsStatus = $('settings-status');

const fillForm = ({ settings, hasApiKey }: SettingsResponse): void => {
  for (const [key, value] of Object.entries(settings)) field(key as keyof Settings).value = String(value);
  const apiKey = field('apiKey');
  apiKey.value = '';
  apiKey.placeholder = hasApiKey ? '•••••• gespeichert (leer lassen = behalten)' : 'kein Key gespeichert';
  $('no-model-hint').hidden = Boolean(settings.chatModel);
};

const loadSettings = async (): Promise<void> => {
  const res = await send({ type: 'getSettings' });
  if (res.ok) fillForm(res.data);
  else settingsStatus.textContent = res.error;
};

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const apiKeyValue = field('apiKey').value.trim();
  const clearKey = $('clear-key', HTMLInputElement).checked;
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
  settingsStatus.textContent = 'Speichern …';
  void send({
    type: 'saveSettings',
    settings,
    apiKey: clearKey ? '' : apiKeyValue || undefined,
  }).then((res) => {
    if (!res.ok) {
      settingsStatus.textContent = `Fehler: ${res.error}`;
      return;
    }
    $('clear-key', HTMLInputElement).checked = false;
    fillForm(res.data);
    settingsStatus.textContent = 'Gespeichert.';
  });
});

$('load-models').addEventListener('click', () => {
  settingsStatus.textContent = 'Lade Modelle … (gespeicherte Base-URL/Key)';
  void send({ type: 'listModels' }).then((res) => {
    if (!res.ok) {
      settingsStatus.textContent = `Verbindung fehlgeschlagen: ${res.error}`;
      return;
    }
    const list = $('models');
    list.replaceChildren(...res.data.map((id) => h('option', { text: id })));
    settingsStatus.textContent = `Verbindung ok – ${String(res.data.length)} Modelle gefunden.`;
  });
});

// --- tabs -------------------------------------------------------------------

const showTab = (tab: 'chat' | 'settings'): void => {
  $('view-chat').hidden = tab !== 'chat';
  $('view-settings').hidden = tab !== 'settings';
  $('tab-chat').classList.toggle('active', tab === 'chat');
  $('tab-settings').classList.toggle('active', tab === 'settings');
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

// Point first-time users to the settings.
void send({ type: 'getSettings' }).then((res) => {
  if (res.ok) $('no-model-hint').hidden = Boolean(res.data.settings.chatModel);
});
input.focus();
