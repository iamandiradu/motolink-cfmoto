import { MotoLink } from '../../modules/moto-link';
import { record, recordFrame } from '../diagnostics/trace';
import { base64Decode, base64Encode } from '../protocol/bytes';
import type { LinkTransport, NetworkInfo, TransportEvent, VideoConfig } from '../protocol/session';

/** Which port each connection belongs to, so the trace can label outgoing frames. */
const portOf = new Map<string, number>();

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
    recordFrame('out', port, data);
    const reply = base64Decode(await MotoLink.probe(host, port, base64Encode(data), timeoutMs));
    recordFrame('in', port, reply);
    return reply;
  },

  send(id, data) {
    recordFrame('out', portOf.get(id) ?? 0, data);
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
      MotoLink.addListener('onConnectionOpen', (e) => {
        portOf.set(e.id, e.port);
        record({ dir: 'note', port: e.port, kind: 'open' });
        listener({ type: 'open', id: e.id, port: e.port });
      }),
      MotoLink.addListener('onConnectionData', (e) =>
        listener({ type: 'data', id: e.id, port: e.port, data: base64Decode(e.data) }),
      ),
      MotoLink.addListener('onConnectionClose', (e) => {
        portOf.delete(e.id);
        record({ dir: 'note', port: e.port, kind: 'close' });
        listener({ type: 'close', id: e.id, port: e.port });
      }),
      MotoLink.addListener('onVideoStats', (e) =>
        listener({ type: 'videoStats', framesSent: e.framesSent, framesDropped: e.framesDropped }),
      ),
    ];
    return () => subscriptions.forEach((s) => s.remove());
  },
};
