declare module 'p2pcf' {
  export interface P2PCFPeer {
    client_id: string;
  }

  export interface P2PCFOptions {
    workerUrl?: string;
    stunIceServers?: RTCIceServer[];
    turnIceServers?: RTCIceServer[];
    networkChangePollIntervalMs?: number;
    stateExpirationIntervalMs?: number;
    fastPollingDurationMs?: number;
    fastPollingRateMs?: number;
    slowPollingRateMs?: number;
    idlePollingAfterMs?: number;
    idlePollingRateMs?: number;
  }

  export default class P2PCF {
    constructor(clientId: string, roomId: string, options?: P2PCFOptions);
    /** This client's own id in the mesh, as passed to the constructor. */
    readonly clientId: string;
    start(): Promise<void>;
    destroy(): void;
    send(peer: P2PCFPeer, data: Uint8Array): void;
    broadcast(data: Uint8Array): void;
    on(event: 'peerconnect'|'peerclose', handler: (peer: P2PCFPeer) => void): this;
    on(event: 'msg', handler: (peer: P2PCFPeer, data: ArrayBuffer) => void): this;
    // The polling tier is chosen inside _step from these mutable fields, so
    // writing them at runtime changes the rate of the next poll.
    /** @internal — epoch ms before which _step skips fetching. */
    nextStepTime: number;
    /** @internal — epoch ms after which the idle rate applies. */
    startIdlePollingAt: number;
    /** @internal — how long after the last peer change idle polling begins. */
    idlePollingAfterMs: number;
    /** @internal — poll interval once idle. */
    idlePollingRateMs: number;
  }
}
