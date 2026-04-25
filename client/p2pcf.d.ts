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
    start(): Promise<void>;
    destroy(): void;
    send(peer: P2PCFPeer, data: Uint8Array): void;
    broadcast(data: Uint8Array): void;
    on(event: 'peerconnect'|'peerclose', handler: (peer: P2PCFPeer) => void): this;
    on(event: 'msg', handler: (peer: P2PCFPeer, data: ArrayBuffer) => void): this;
    /** @internal — epoch ms before which _step skips fetching. Set to Infinity to pause polling. */
    nextStepTime: number;
    /** @internal — interval handle for NAT-type rechecks; null after clearing. */
    networkSettingsInterval: ReturnType<typeof setInterval> | null;
  }
}
