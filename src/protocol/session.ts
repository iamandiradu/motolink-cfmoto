/**
 * Link session: joins the dash network, runs the handshake, keeps the link
 * alive and reconnects after an ignition cycle. Owns no sockets itself; all
 * I/O goes through LinkTransport so the logic runs under Jest with a fake.
 *
 * Topology reminder: the PHONE is the server. It listens on 10922/10921/10920,
 * sends one probe to dash:10930, and the dash dials back.
 */
import {
  ControlAction,
  DashInfo,
  DEFAULT_IDENTITY,
  PhoneIdentity,
  buildClientInfoReply,
  buildProbe,
  handleControlFrame,
  isProbeAccepted,
} from './control';
import {
  Cmd,
  ControlParser,
  MediaParser,
  PORT_CONTROL,
  PORT_MEDIA_CONTROL,
  PORT_MEDIA_DATA,
  PORT_PROBE,
  cmdName,
  encodeControl,
} from './frames';
import { CaptureConfig, TouchEvent, handleMediaFrame } from './media';
import { describeControl, describeMedia, record } from '../diagnostics/trace';
import { BikeCredentials, fallbackDashAddress } from './qr';

export type LinkState =
  | 'idle'
  /** Not on the dash network yet (bike off, or Wi-Fi not joined). */
  | 'searching'
  | 'probing'
  /** Probe accepted, waiting for the dash to dial back. */
  | 'waitingForDash'
  | 'handshaking'
  /** Picture size agreed, dash has not started pulling. */
  | 'negotiated'
  | 'streaming';

export interface NetworkInfo {
  /** Phone IPv4 on Wi-Fi, null when Wi-Fi has no address. */
  ip: string | null;
  /** Best guess of the dash address (gateway). */
  gateway: string | null;
}

export interface VideoConfig {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  keyframeIntervalSec: number;
}

export type TransportEvent =
  | { type: 'open'; id: string; port: number }
  | { type: 'data'; id: string; port: number; data: Uint8Array }
  | { type: 'close'; id: string; port: number }
  /** Sent about once a second while the dash pulls frames on 10920. */
  | { type: 'videoStats'; framesSent: number; framesDropped: number };

export interface LinkTransport {
  /** Asks iOS to join the dash network. Rejects when the entitlement is missing or the user declines. */
  joinWifi(ssid: string, password: string): Promise<void>;
  getNetworkInfo(): Promise<NetworkInfo>;
  /** Opens the three listeners. Port 10920 is served natively. */
  startServers(): Promise<void>;
  stopServers(): Promise<void>;
  /** One request/reply exchange on a fresh outbound TCP connection. */
  probe(host: string, port: number, data: Uint8Array, timeoutMs: number): Promise<Uint8Array>;
  send(id: string, data: Uint8Array): void;
  closeConnection(id: string): void;
  /** Creates the session RSA-1024 key; resolves base64 SubjectPublicKeyInfo. */
  createIdentity(): Promise<string>;
  /** PKCS#1 v1.5 private-key operation over the HUID, base64. */
  signHuid(huid: string): Promise<string>;
  configureVideo(config: VideoConfig): Promise<void>;
  /** Flush queued frames and force the next frame to be SPS+PPS+IDR. */
  restartStream(): Promise<void>;
  stopVideo(): Promise<void>;
  subscribe(listener: (event: TransportEvent) => void): () => void;
}

export interface SessionOptions {
  identity: PhoneIdentity;
  bitrate: number;
  keyframeIntervalSec: number;
  /** Phone-side heartbeat on both control sockets. Some dashes send none and time out at ~7 s. */
  heartbeatMs: number;
  /** Delay between attempts while the bike is out of reach. */
  retryMs: number;
  probeAttempts: number;
  probeTimeoutMs: number;
  /** How long to wait for the dash to dial back after an accepted probe. */
  dialBackMs: number;
  /** Streaming with no pulled frame for this long means the link is dead. */
  stallMs: number;
  /** Ask iOS to join the dash Wi-Fi when it is not already on it. */
  autoJoinWifi: boolean;
  /**
   * Address to probe instead of the Wi-Fi gateway. For testing against the
   * dash simulator on a computer; null on a real bike.
   */
  dashHost: string | null;
}

export const DEFAULT_OPTIONS: SessionOptions = {
  identity: DEFAULT_IDENTITY,
  bitrate: 1_500_000,
  keyframeIntervalSec: 5,
  heartbeatMs: 2000,
  retryMs: 5000,
  probeAttempts: 5,
  probeTimeoutMs: 5000,
  dialBackMs: 10_000,
  stallMs: 12_000,
  autoJoinWifi: true,
  dashHost: null,
};

export interface SessionSnapshot {
  state: LinkState;
  dash: DashInfo | null;
  capture: CaptureConfig | null;
  framesSent: number;
  framesDropped: number;
  lastError: string | null;
}

export interface SessionListener {
  onChange?(snapshot: SessionSnapshot): void;
  onTouch?(touch: TouchEvent): void;
  onLog?(message: string): void;
}

interface Connection {
  id: string;
  port: number;
  control?: ControlParser;
  media?: MediaParser;
}

function uuid(): string {
  const h = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${h(8)}-${h(4)}-4${h(3)}-a${h(3)}-${h(12)}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class LinkSession {
  private readonly options: SessionOptions;
  private snapshot: SessionSnapshot = {
    state: 'idle',
    dash: null,
    capture: null,
    framesSent: 0,
    framesDropped: 0,
    lastError: null,
  };
  private readonly connections = new Map<string, Connection>();
  private unsubscribe: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private creds: BikeCredentials | null = null;
  private publicKey = '';
  private readonly phoneUuid = uuid();
  /** Bumped on stop(); loops from an older run see the change and exit. */
  private generation = 0;
  private lastFrameAt = 0;
  private lastFramesSent = 0;
  private serversUp = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly transport: LinkTransport,
    private readonly listener: SessionListener = {},
    options: Partial<SessionOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  getSnapshot(): SessionSnapshot {
    return this.snapshot;
  }

  /** Starts connecting and keeps reconnecting until stop(). */
  start(creds: BikeCredentials): void {
    this.stopInternal();
    this.creds = creds;
    const generation = ++this.generation;
    this.unsubscribe = this.transport.subscribe((event) => this.onEvent(event));
    void this.run(generation);
  }

  async stop(): Promise<void> {
    this.stopInternal();
    this.update({ state: 'idle', dash: null, capture: null });
    await this.transport.stopVideo().catch(() => undefined);
    await this.transport.stopServers().catch(() => undefined);
  }

  private stopInternal(): void {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimers();
    this.connections.clear();
    this.serversUp = false;
    this.wake?.();
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watchdog) clearInterval(this.watchdog);
    this.heartbeat = null;
    this.watchdog = null;
  }

  private log(message: string): void {
    this.listener.onLog?.(message);
  }

  private update(patch: Partial<SessionSnapshot>): void {
    if (patch.state && patch.state !== this.snapshot.state) {
      record({ dir: 'note', port: null, kind: `state ${patch.state}` });
    }
    this.snapshot = { ...this.snapshot, ...patch };
    this.listener.onChange?.(this.snapshot);
  }

  private alive(generation: number): boolean {
    return generation === this.generation;
  }

  /** Sleeps, but returns early when a connection event should re-evaluate the loop. */
  private async pause(ms: number): Promise<void> {
    await Promise.race([sleep(ms), new Promise<void>((resolve) => (this.wake = resolve))]);
    this.wake = null;
  }

  private async run(generation: number): Promise<void> {
    try {
      this.publicKey = await this.transport.createIdentity();
    } catch (error) {
      this.update({ lastError: `RSA key: ${String(error)}` });
      return;
    }

    while (this.alive(generation)) {
      try {
        const linked = await this.attempt(generation);
        if (!this.alive(generation)) return;
        if (linked) {
          // Stay here until every dash connection is gone, then start over.
          while (this.alive(generation) && this.connections.size > 0) await this.pause(1000);
          if (!this.alive(generation)) return;
          this.log('dash disconnected');
          this.clearTimers();
          await this.transport.stopVideo().catch(() => undefined);
          this.update({ state: 'searching', capture: null });
          continue;
        }
      } catch (error) {
        this.update({ lastError: String(error) });
        this.log(`attempt failed: ${String(error)}`);
      }
      if (!this.alive(generation)) return;
      await this.pause(this.options.retryMs);
    }
  }

  /** One connection attempt. Resolves true once the dash has dialled back. */
  private async attempt(generation: number): Promise<boolean> {
    const creds = this.creds!;
    this.update({ state: 'searching' });

    let net = await this.transport.getNetworkInfo();
    if (!net.ip && this.options.autoJoinWifi && !this.options.dashHost) {
      await this.transport.joinWifi(creds.ssid, creds.password).catch((error) => {
        this.log(`Wi-Fi join not available: ${String(error)}`);
      });
      net = await this.transport.getNetworkInfo();
    }
    if (!this.alive(generation) || !net.ip) return false;

    if (!this.serversUp) {
      await this.transport.startServers();
      this.serversUp = true;
    }

    const candidates = this.options.dashHost ? [this.options.dashHost] : [net.gateway, fallbackDashAddress(creds)];
    const hosts = candidates.filter(
      (host, index, all): host is string => !!host && all.indexOf(host) === index,
    );

    this.update({ state: 'probing' });
    const probe = buildProbe(this.options.identity);
    let accepted = false;
    for (let attempt = 1; attempt <= this.options.probeAttempts && !accepted; attempt++) {
      for (const host of hosts) {
        if (!this.alive(generation)) return false;
        try {
          const reply = await this.transport.probe(host, PORT_PROBE, probe, this.options.probeTimeoutMs);
          const frames = new ControlParser().push(reply);
          if (frames.length > 0 && isProbeAccepted(frames[0])) {
            accepted = true;
            this.log(`probe accepted by ${host}`);
            break;
          }
          this.log(`probe rejected by ${host}`);
        } catch (error) {
          this.log(`probe ${host} #${attempt}: ${String(error)}`);
        }
      }
      // The dash may already be dialling in from an earlier probe.
      if (this.connections.size > 0) accepted = true;
      if (!accepted && attempt < this.options.probeAttempts) await this.pause(750 * attempt);
    }
    if (!accepted) {
      // Wi-Fi has an address but no dash answered: the phone is probably on another network.
      if (this.options.autoJoinWifi && !this.options.dashHost) {
        await this.transport.joinWifi(creds.ssid, creds.password).catch(() => undefined);
      }
      return false;
    }

    if (this.connections.size === 0) {
      this.update({ state: 'waitingForDash' });
      const deadline = Date.now() + this.options.dialBackMs;
      while (this.alive(generation) && this.connections.size === 0 && Date.now() < deadline) {
        await this.pause(250);
      }
    }
    if (this.connections.size === 0) {
      this.log('dash did not dial back');
      return false;
    }
    this.update({ lastError: null });
    return true;
  }

  private onEvent(event: TransportEvent): void {
    switch (event.type) {
      case 'open':
        this.onOpen(event.id, event.port);
        break;
      case 'data':
        this.onData(event.id, event.data);
        break;
      case 'close':
        this.connections.delete(event.id);
        this.log(`closed :${event.port}`);
        this.wake?.();
        break;
      case 'videoStats':
        if (event.framesSent !== this.lastFramesSent) {
          this.lastFramesSent = event.framesSent;
          this.lastFrameAt = Date.now();
          if (this.snapshot.state === 'negotiated') this.update({ state: 'streaming' });
        }
        this.update({ framesSent: event.framesSent, framesDropped: event.framesDropped });
        break;
    }
  }

  private onOpen(id: string, port: number): void {
    const connection: Connection = { id, port };
    if (port === PORT_CONTROL) connection.control = new ControlParser();
    else if (port === PORT_MEDIA_CONTROL) connection.media = new MediaParser();
    this.connections.set(id, connection);
    this.log(`dash connected :${port}`);
    if (port === PORT_CONTROL && this.snapshot.state !== 'streaming' && this.snapshot.state !== 'negotiated') {
      this.update({ state: 'handshaking' });
    }
    this.startTimers();
    this.wake?.();
  }

  private startTimers(): void {
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        const beat = encodeControl(Cmd.HEARTBEAT);
        for (const c of this.connections.values()) if (c.port === PORT_CONTROL) this.transport.send(c.id, beat);
      }, this.options.heartbeatMs);
    }
    if (!this.watchdog) {
      this.watchdog = setInterval(() => {
        if (this.snapshot.state !== 'streaming') return;
        if (Date.now() - this.lastFrameAt < this.options.stallMs) return;
        this.log('video stalled, dropping link to force a reconnect');
        this.lastFrameAt = Date.now();
        for (const c of [...this.connections.values()]) this.transport.closeConnection(c.id);
      }, 5000);
    }
  }

  private onData(id: string, data: Uint8Array): void {
    const connection = this.connections.get(id);
    if (!connection) return;
    try {
      if (connection.control) {
        for (const frame of connection.control.push(data)) {
          record({
            dir: 'in',
            port: connection.port,
            kind: describeControl(frame.cmd, frame.payload.length),
            data: frame.payload,
            bytes: 16 + frame.payload.length,
          });
          if (frame.cmd !== Cmd.HEARTBEAT && frame.cmd !== Cmd.HEARTBEAT_ACK && frame.cmd !== Cmd.HU_TIME_SYNC) {
            this.log(`ctrl <- ${cmdName(frame.cmd)} (${frame.payload.length})`);
          }
          for (const action of handleControlFrame(frame)) this.applyControl(id, action);
        }
      } else if (connection.media) {
        for (const frame of connection.media.push(data)) {
          record({
            dir: 'in',
            port: connection.port,
            kind: describeMedia(frame.cmdType, frame.body.length),
            data: frame.body,
            bytes: 8 + frame.body.length,
          });
          for (const action of handleMediaFrame(frame)) {
            switch (action.type) {
              case 'send':
                this.transport.send(id, action.data);
                break;
              case 'configure':
                void this.configure(action.config);
                break;
              case 'startStream':
                this.lastFrameAt = Date.now();
                void this.transport.restartStream();
                if (this.snapshot.state !== 'streaming') this.update({ state: 'negotiated' });
                break;
              case 'touch':
                this.listener.onTouch?.(action.touch);
                break;
              case 'log':
                this.log(action.message);
                break;
            }
          }
        }
      }
    } catch (error) {
      this.log(`protocol error on :${connection.port}: ${String(error)}`);
      this.transport.closeConnection(id);
    }
  }

  private applyControl(id: string, action: ControlAction): void {
    switch (action.type) {
      case 'send':
        this.transport.send(id, action.data);
        break;
      case 'log':
        this.log(action.message);
        break;
      case 'clientInfo':
        this.update({ dash: action.dash });
        void this.replyClientInfo(id, action.dash);
        break;
    }
  }

  private async replyClientInfo(id: string, dash: DashInfo): Promise<void> {
    let encryptedHuid = '';
    try {
      if (dash.huid) encryptedHuid = await this.transport.signHuid(dash.huid);
    } catch (error) {
      this.log(`HUID signing failed: ${String(error)}`);
    }
    this.transport.send(
      id,
      buildClientInfoReply({
        identity: this.options.identity,
        phoneUuid: this.phoneUuid,
        publicKey: this.publicKey,
        encryptedHuid,
      }),
    );
  }

  private async configure(config: CaptureConfig): Promise<void> {
    this.log(`dash asked for ${config.deviceWidth}x${config.deviceHeight}@${config.fps}`);
    this.update({ capture: config, state: 'negotiated' });
    await this.transport.configureVideo({
      width: config.width,
      height: config.height,
      fps: config.fps,
      bitrate: this.options.bitrate,
      keyframeIntervalSec: this.options.keyframeIntervalSec,
    });
  }
}

export { PORT_MEDIA_DATA };
