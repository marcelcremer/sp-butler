import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';
import { createZip } from '../scripts/zip.ts';

/** Reads entries back via the central directory, like an unzip tool would. */
const readZip = (zip: Buffer): Map<string, Buffer> => {
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50);
    const crc = zip.readUInt32LE(p + 16);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const start = localOffset + 30 + localNameLen;
    const data = inflateRawSync(zip.subarray(start, start + size));
    assert.equal(crc32(data), crc);
    out.set(name, data);
    p += 46 + nameLen;
  }
  return out;
};

describe('createZip', () => {
  it('round-trips entries including UTF-8 names', () => {
    const entries = [
      { name: 'manifest.json', data: Buffer.from('{"id":"x"}') },
      { name: 'résumé-ü.txt', data: Buffer.from('ä'.repeat(1000)) },
      { name: 'empty', data: Buffer.alloc(0) },
    ];
    const files = readZip(createZip(entries));
    assert.deepEqual([...files.keys()], entries.map((e) => e.name));
    for (const e of entries) assert.deepEqual(files.get(e.name), e.data);
  });
});
