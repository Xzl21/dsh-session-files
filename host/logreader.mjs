// Session-log reader for dsh-session-files.
//
// A `session.v4.jsonl.zstd` log is NOT one zstd stream: the log writer flushes
// one independent zstd frame per batch, and Node's `zstdDecompressSync` stops
// after the first frame (a 540 KB log decompresses to the 202-byte header
// line). We therefore split the buffer at zstd frame magics and decompress the
// frames one by one.
//
// A magic sequence can legitimately occur inside compressed payload bytes, so
// candidate offsets are disambiguated the same way the reference plugins do it:
// starting at a candidate, grow the slice frame by frame until `zstdDecompressSync`
// accepts it. A truncated (cut-through) frame throws, so the first accepted
// slice ends on a real frame boundary and the cursor jumps over the bogus magic.
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
// Guard against pathological inputs: every attempt costs a decompress.
const ATTEMPT_MULTIPLIER = 4;
const ATTEMPT_BASE = 1000;

function frameOffsets(buffer) {
  const offsets = [];
  let cursor = 0;
  while (cursor + 3 < buffer.length) {
    let found = -1;
    for (let at = cursor; at + 3 < buffer.length; at++) {
      if (
        buffer[at] === MAGIC[0] &&
        buffer[at + 1] === MAGIC[1] &&
        buffer[at + 2] === MAGIC[2] &&
        buffer[at + 3] === MAGIC[3]
      ) {
        found = at;
        break;
      }
    }
    if (found < 0) break;
    offsets.push(found);
    cursor = found + 4;
  }
  return offsets;
}

// The real header line is `{ "type": "session", "version": 4, "id": ..., "createdAt": ..., "cwd": ... }`.
// Tolerate an envelope (`{ type: 'session/header', data: {...} }`) as well, because older
// logs may nest the header.
function looksLikeHeader(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.type === 'session') return true;
  if (value.type === 'session/header') {
    return Boolean(value.data) && typeof value.data === 'object' && !Array.isArray(value.data);
  }
  return typeof value.id === 'string' && typeof value.createdAt === 'number' && value.type === undefined;
}

function unwrapHeader(value) {
  if (value.type === 'session/header' && value.data && typeof value.data === 'object') return value.data;
  return value;
}

/**
 * Read and decode one session log file.
 * @param {string} filePath absolute path to `session.v4.jsonl.zstd`
 * @returns {{ header: object|null, events: object[], frames: number, badFrames: number }}
 */
export function readSessionLog(filePath) {
  const raw = readFileSync(filePath);
  const offsets = frameOffsets(raw);
  const parts = [];
  let badFrames = 0;
  let attemptsLeft = offsets.length * ATTEMPT_MULTIPLIER + ATTEMPT_BASE;

  let index = 0;
  while (index < offsets.length) {
    let decoded = false;
    for (let next = index + 1; next <= offsets.length; next++) {
      if (attemptsLeft-- <= 0) break;
      const end = next < offsets.length ? offsets[next] : raw.length;
      try {
        parts.push(zstdDecompressSync(raw.subarray(offsets[index], end)));
        index = next;
        decoded = true;
        break;
      } catch {
        // Truncated slice: extend to the next candidate boundary and retry.
      }
    }
    if (!decoded) {
      badFrames++;
      index++;
    }
  }

  const text = Buffer.concat(parts).toString('utf8');
  let header = null;
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      badFrames++;
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    if (header === null && looksLikeHeader(value)) {
      header = unwrapHeader(value);
      continue;
    }
    events.push(value);
  }
  return { header, events, frames: offsets.length, badFrames };
}
