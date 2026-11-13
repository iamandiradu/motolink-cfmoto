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
  onAudioRoute: (event: { outputs: string[] }) => void;
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
  /** Info strip beside the mirrored picture. Colours are 0xRRGGBB. */
  setMirrorStrip(strip: {
    enabled: boolean;
    edge: 'bottom' | 'top';
    height: number;
    left: string;
    center: string;
    right: string;
    background: number;
    text: number;
    accent: number;
  }): void;
  /** Starts or refreshes the lock-screen ride activity. False when iOS refused. */
  updateLiveActivity(state: {
    linkState: 'searching' | 'connecting' | 'onDash' | 'off';
    mirroring: boolean;
    speed: number | null;
    speedUnit: string;
    tripText: string;
    trackTitle: string | null;
  }): boolean;
  endLiveActivity(): void;
  getBluetoothOutputs(): string[];
  requestNotificationPermission(): Promise<boolean>;
  notify(title: string, body: string): Promise<void>;
  showBroadcastPicker(): Promise<void>;
  /** Thousandths: zoom 1000 = 1x, trimTop 60 = cut top 6 %. fit: 0 auto, 1 fill, 2 fit. */
  setMirrorView(view: {
    zoom: number;
    trimTop: number;
    trimBottom: number;
    trimLeft: number;
    trimRight: number;
    fit: number;
  }): void;
}

export const MotoLink = requireNativeModule<MotoLinkNativeModule>('MotoLink');

/** Container whose children are captured and streamed to the dash. */
export const DashSurfaceView: ComponentType<{
  style?: StyleProp<ViewStyle>;
  label?: string;
  children?: ReactNode;
}> = requireNativeView('MotoLink');
