import { NativeModule, requireNativeModule, requireNativeView } from 'expo';
import type { ComponentType, ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

/** keepAlive captures nothing; it only keeps the app running behind another app. */
export type ButtonCaptureMode = 'keepAlive' | 'volume' | 'full';

export type NativeButtonEvent =
  | { type: 'volume'; delta: number }
  | { type: 'key'; key: 'playPause' | 'next' | 'previous' };

type MotoLinkEvents = {
  onConnectionOpen: (event: { id: string; port: number }) => void;
  onConnectionData: (event: { id: string; port: number; data: string }) => void;
  onConnectionClose: (event: { id: string; port: number }) => void;
  onVideoStats: (event: { framesSent: number; framesDropped: number }) => void;
  onButton: (event: NativeButtonEvent) => void;
  onLog: (event: { message: string }) => void;
  onMirrorState: (event: { active: boolean }) => void;
};

declare class MotoLinkNativeModule extends NativeModule<MotoLinkEvents> {
  getNetworkInfo(): { ip?: string; gateway?: string };
  joinWifi(ssid: string, password: string): Promise<void>;
  startServers(): Promise<void>;
  stopServers(): Promise<void>;
  probe(host: string, port: number, dataBase64: string, timeoutMs: number): Promise<string>;
  send(id: string, dataBase64: string): void;
  closeConnection(id: string): void;
  createIdentity(): Promise<string>;
  signHuid(huid: string): Promise<string>;
  configureVideo(config: {
    width: number;
    height: number;
    fps: number;
    bitrate: number;
    keyframeIntervalSec: number;
  }): Promise<void>;
  restartStream(): Promise<void>;
  stopVideo(): Promise<void>;
  startButtonCapture(mode: ButtonCaptureMode, pinVolume: boolean): Promise<void>;
  stopButtonCapture(): Promise<void>;
  reannounceButtons(): Promise<void>;
  isMirroring(): boolean;
  showBroadcastPicker(): Promise<void>;
}

export const MotoLink = requireNativeModule<MotoLinkNativeModule>('MotoLink');

/** Container whose children are captured and streamed to the dash. */
export const DashSurfaceView: ComponentType<{
  style?: StyleProp<ViewStyle>;
  label?: string;
  children?: ReactNode;
}> = requireNativeView('MotoLink');
