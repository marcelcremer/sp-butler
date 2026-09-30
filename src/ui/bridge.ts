// Request/response channel from the iframe to plugin.js. The host forwards
// `PLUGIN_MESSAGE` posts to the handler registered with PluginAPI.onMessage.

import type { UiRequest, UiResponse } from '../shared/protocol.ts';
import { t } from './i18n.ts';

const MESSAGE = 'PLUGIN_MESSAGE';
const MESSAGE_RESPONSE = 'PLUGIN_MESSAGE_RESPONSE';
const MESSAGE_ERROR = 'PLUGIN_MESSAGE_ERROR';
/** LLM turns with several tool rounds can take a while. */
const TIMEOUT_MS = 5 * 60 * 1000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let counter = 0;

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent) return;
  const data = event.data as { type?: unknown; messageId?: unknown; result?: unknown; error?: unknown } | null;
  if (!data || typeof data.messageId !== 'string') return;
  const entry = pending.get(data.messageId);
  if (!entry) return;
  if (data.type === MESSAGE_RESPONSE) entry.resolve(data.result);
  else if (data.type === MESSAGE_ERROR) entry.reject(new Error(String(data.error)));
  else return;
  clearTimeout(entry.timer);
  pending.delete(data.messageId);
});

export const send = async <T extends UiRequest>(req: T): Promise<UiResponse<T['type']>> => {
  const messageId = `spb-${String(Date.now())}-${String(++counter)}`;
  const result = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(messageId);
      reject(new Error(t('ERRORS.BRIDGE_TIMEOUT')));
    }, TIMEOUT_MS);
    pending.set(messageId, { resolve, reject, timer });
    window.parent.postMessage({ type: MESSAGE, messageId, message: req }, '*');
  });
  if (!result || typeof result !== 'object' || !('ok' in result)) {
    return { ok: false, error: t('ERRORS.BRIDGE_INVALID') };
  }
  return result as UiResponse<T['type']>;
};
