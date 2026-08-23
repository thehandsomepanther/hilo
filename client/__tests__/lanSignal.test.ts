import { describe, it, expect } from 'vitest';
import { encodePayload, decodePayload } from '../lanSignal';
import type { LanOffer, LanAnswer } from '../lanSignal';

/**
 * A real LAN-only offer, captured from Chrome with `iceServers: []` and camera
 * permission held (so candidates are real addresses rather than mDNS names).
 * Kept verbatim because the size assertion below is only meaningful against a
 * realistic payload.
 */
const REAL_SDP = `v=0
o=- 9009696913056202156 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=extmap-allow-mixed
a=msid-semantic: WMS
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 0.0.0.0
a=candidate:1952604956 1 udp 2122194687 192.168.1.144 61869 typ host generation 0 network-id 1
a=candidate:997145318 1 udp 2122262783 2600:1700:7000:1140:edc0:45c:4d8d:f0f8 62224 typ host generation 0 network-id 2
a=candidate:179143044 1 tcp 1518214911 192.168.1.144 9 typ host tcptype active generation 0 network-id 1
a=ice-ufrag:nVtL
a=ice-pwd:zkp67vVXEBmovVRvSmHCFYKe
a=ice-options:trickle
a=fingerprint:sha-256 EE:B7:E7:BE:CB:54:87:63:E7:1D:2F:CE:5D:AE:CA:9E:BA:B8:7E:36:3F:AC:5D:F6:17:DE:5E:7A:D2:48:21:20
a=setup:actpass
a=mid:0
a=sctp-port:5000
a=max-message-size:262144
`;

const offer: LanOffer = { v: 1, t: 'offer', s: 'AB3X7K', sdp: REAL_SDP };
const answer: LanAnswer = { v: 1, t: 'answer', s: 'AB3X7K', c: 'PQ7R2M9T', sdp: REAL_SDP };

describe('LAN signalling payloads', () => {
  it('round-trips an offer', async () => {
    expect(await decodePayload(await encodePayload(offer))).toEqual(offer);
  });

  it('round-trips an answer, preserving the peer id', async () => {
    const back = await decodePayload(await encodePayload(answer));
    expect(back).toEqual(answer);
    expect((back as LanAnswer).c).toBe('PQ7R2M9T');
  });

  /**
   * The whole design rests on one code being scannable off another phone's
   * screen. A version-40 QR holds 2953 bytes at L error correction, and we
   * encode at M (2331). Blowing through that turns one scan into a multi-frame
   * animation, so it should fail here rather than in someone's hands.
   */
  it('encodes a real SDP small enough for a single QR code', async () => {
    const encoded = await encodePayload(offer);
    expect(encoded.length).toBeLessThan(2331);
    // Sanity: deflate should be pulling real weight, not silently disabled.
    expect(encoded.length).toBeLessThan(REAL_SDP.length);
  });

  it('rejects text that is not one of our codes', async () => {
    await expect(decodePayload('https://example.com')).rejects.toThrow(/Equation Hi-Lo/);
  });

  it('rejects a payload from a different app version', async () => {
    const future = await encodePayload({ ...offer, v: 99 });
    await expect(decodePayload(future)).rejects.toThrow(/different version/);
  });

  it('rejects a corrupted code rather than returning nonsense', async () => {
    const good = await encodePayload(offer);
    const corrupted = `${good.slice(0, 20)}!!!!${good.slice(24)}`;
    await expect(decodePayload(corrupted)).rejects.toThrow();
  });
});
