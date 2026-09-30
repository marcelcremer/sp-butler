import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import de from '../src/i18n/de.json' with { type: 'json' };
import en from '../src/i18n/en.json' with { type: 'json' };
import { createTranslator, interpolate, LocalizedError, lookup } from '../src/shared/i18n.ts';
import { resolveLanguage } from '../src/ui/i18n.ts';

const leaves = (node: unknown, prefix = ''): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of leaves(value, path)) out.set(k, v);
  }
  return out;
};

const placeholders = (s: string): string[] => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1] ?? '').sort();

describe('translation files', () => {
  const enLeaves = leaves(en);
  const deLeaves = leaves(de);

  it('have the same keys', () => {
    assert.deepEqual([...deLeaves.keys()].sort(), [...enLeaves.keys()].sort());
  });

  it('use the same placeholders per key', () => {
    for (const [key, value] of enLeaves) {
      assert.deepEqual(placeholders(deLeaves.get(key) ?? ''), placeholders(value), key);
    }
  });

  it('cover every key referenced in index.html', () => {
    const html = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
    const keys = [...html.matchAll(/data-(?:i18n(?:-[a-z-]+)?|prompt)="([^"]+)"/g)].map((m) => m[1] ?? '');
    assert.ok(keys.length > 30);
    for (const key of keys) assert.ok(enLeaves.has(key), `missing key ${key}`);
  });
});

describe('translator', () => {
  const t = createTranslator(de);

  it('interpolates {{params}} and leaves unknown ones', () => {
    assert.equal(interpolate('{{a}} of {{ b }} {{c}}', { a: 1, b: 'x' }), '1 of x {{c}}');
  });

  it('translates, falls back to English, then to the key', () => {
    assert.equal(t('PROPOSAL.APPLY_SOME', { selected: 1, total: 3 }), '1 von 3 übernehmen');
    assert.equal(createTranslator({})('PROPOSAL.APPLY'), 'Apply');
    assert.equal(lookup(en, 'NOPE.MISSING'), undefined);
  });

  it('keeps English messages on LocalizedError for logs', () => {
    const e = new LocalizedError('ERRORS.TIMEOUT', { ms: 5, url: 'u' });
    assert.equal(e.message, 'Timed out after 5 ms (u).');
    assert.equal(e.key, 'ERRORS.TIMEOUT');
  });

  it('resolves app language codes', () => {
    assert.equal(resolveLanguage('de'), 'de');
    assert.equal(resolveLanguage('de-DE'), 'de');
    assert.equal(resolveLanguage('pt-br'), 'en');
    assert.equal(resolveLanguage(undefined), 'en');
  });
});
