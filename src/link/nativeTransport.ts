import { MotoLink } from '../../modules/moto-link';
import { base64Decode, base64Encode } from '../protocol/bytes';
import type { LinkTransport, NetworkInfo, TransportEvent, VideoConfig } from '../protocol/session';

/** LinkTransport backed by the native module. Bytes cross the bridge as base64. */
export const nativeTransport: LinkTransport = {
  joinWifi: (ssid, password) => MotoLink.joinWifi(ssid, password),

  async getNetworkInfo(): Promise<NetworkInfo> {
    const info = MotoLink.getNetworkInfo();
    return { ip: info.ip ?? null, gateway: info.gateway ?? null };
  },

  startServers: () => MotoLink.startServers(),
  stopServers: () => MotoLink.stopServers(),

  async probe(host, port, data, timeoutMs) {
    return base64Decode(await MotoLink.probe(host, port, base64Encode(data), timeoutMs));
  },

  send(id, data) {
    MotoLink.send(id, base64Encode(data));
  },

  closeConnection(id) {
    MotoLink.closeConnection(id);
  },

  createIdentity: () => MotoLink.createIdentity(),
  signHuid: (huid) => MotoLink.signHuid(huid),
  configureVideo: (config: VideoConfig) => MotoLink.configureVideo(config),
  restartStream: () => MotoLink.restartStream(),
  stopVideo: () => MotoLink.stopVideo(),

  subscribe(listener: (event: TransportEvent) => void) {
    const subscriptions = [
      MotoLink.addListener('onConnectionOpen', (e) => listener({ type: 'open', id: e.id, port: e.port })),
      MotoLink.addListener('onConnectionData', (e) =>
        listener({ type: 'data', id: e.id, port: e.port, data: base64Decode(e.data) }),
      ),
      MotoLink.addListener('onConnectionClose', (e) => listener({ type: 'close', id: e.id, port: e.port })),
      MotoLink.addListener('onVideoStats', (e) =>
        listener({ type: 'videoStats', framesSent: e.framesSent, framesDropped: e.framesDropped }),
      ),
    ];
    return () => subscriptions.forEach((s) => s.remove());
  },
};
