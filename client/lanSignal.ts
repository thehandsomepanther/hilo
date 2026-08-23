/**
 * lanSignal.ts — the payloads two devices show each other as QR codes when
 * there is no signalling server to introduce them.
 *
 * WebRTC needs a two-way exchange, so the flow is two scans: the host shows an
 * offer, the peer scans it and shows back an answer, the host scans that. After
 * that the data channel is up and nothing else is ever signalled — see
 * lanTransport.ts.
 *
 * Size matters, because everything here has to survive being photographed off
 * another phone's screen. A measured LAN-only offer is ~715 bytes of SDP;
 * deflate + base64 brings it to ~630 characters, which lands around QR version
 * 20 — dense but comfortably scannable, and far below the 2953-byte ceiling of
 * a version-40 code. That headroom is why the full SDP is sent verbatim rather
 * than picked apart into a compact custom encoding: reconstructing an SDP from
 * its interesting fields is browser-specific and fragile, and there is no size
 * pressure forcing us into it.
 */

/** Bumped if the payload shape ever changes, so an old QR fails loudly. */
const PAYLOAD_VERSION = 1;

export type LanOffer = { v: number; t: 'offer'; s: string; sdp: string };
export type LanAnswer = { v: number; t: 'answer'; s: string; c: string; sdp: string };
export type LanPayload = LanOffer | LanAnswer;

// Prefixes so a reader knows how the bytes were packed.  'D' is the normal
// path; 'J' is the fallback for browsers without CompressionStream (Safari
// gained it in 16.4), where a slightly denser QR beats not working at all.
const DEFLATED = 'D';
const PLAIN = 'J';

function hasCompressionStream(): boolean {
  return typeof globalThis.CompressionStream === 'function';
}

// The ArrayBuffer type argument is not decoration: the stream APIs refuse a
// view that might be backed by a SharedArrayBuffer.
async function pump(
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes);
  void writer.close();

  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// btoa needs a binary string; build it in chunks so a large payload can't blow
// the argument limit on String.fromCharCode.
function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encodePayload(payload: LanPayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if (!hasCompressionStream()) return PLAIN + bytesToBase64(json);
  const deflated = await pump(json, new CompressionStream('deflate-raw'));
  return DEFLATED + bytesToBase64(deflated);
}

export async function decodePayload(text: string): Promise<LanPayload> {
  const kind = text[0];
  const body = text.slice(1);
  if (kind !== DEFLATED && kind !== PLAIN) {
    throw new Error("That doesn't look like an Equation Hi-Lo code.");
  }

  let json: Uint8Array;
  try {
    const bytes = base64ToBytes(body);
    json = kind === DEFLATED
      ? await pump(bytes, new DecompressionStream('deflate-raw'))
      : bytes;
  } catch {
    throw new Error('That code could not be read — try scanning it again.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(json));
  } catch {
    throw new Error('That code could not be read — try scanning it again.');
  }

  const p = parsed as Partial<LanPayload>;
  if (!p || (p.t !== 'offer' && p.t !== 'answer') || typeof p.sdp !== 'string') {
    throw new Error("That doesn't look like an Equation Hi-Lo code.");
  }
  if (p.v !== PAYLOAD_VERSION) {
    throw new Error('That code was made by a different version of the app.');
  }
  return p as LanPayload;
}
