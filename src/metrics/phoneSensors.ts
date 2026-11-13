import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';

import type { MetricsSample, MetricsSource } from './trip';

const toDeg = (rad: number) => (rad * 180) / Math.PI;

/**
 * Metrics from the phone itself: GPS speed, heading, altitude and position,
 * plus lean angle from the motion sensors. Lean is relative to how the phone
 * sat when the source started, so start it with the bike upright.
 */
export class PhoneSensorSource implements MetricsSource {
  readonly id = 'phone';
  private position: Location.LocationSubscription | null = null;
  private motion: { remove(): void } | null = null;
  private leanZero: number | null = null;

  async start(emit: (sample: MetricsSample) => void): Promise<void> {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.granted) {
      this.position = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
        ({ coords, timestamp }) => {
          const sample: MetricsSample = {
            timestamp,
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracyM: coords.accuracy ?? undefined,
          };
          // iOS reports -1 when speed or course is unknown.
          if (typeof coords.speed === 'number' && coords.speed >= 0) sample.speedKmh = coords.speed * 3.6;
          if (typeof coords.heading === 'number' && coords.heading >= 0) sample.headingDeg = coords.heading;
          if (typeof coords.altitude === 'number') sample.altitudeM = coords.altitude;
          emit(sample);
        },
      );
    }

    if (await DeviceMotion.isAvailableAsync()) {
      DeviceMotion.setUpdateInterval(200);
      this.motion = DeviceMotion.addListener(({ rotation }) => {
        if (!rotation) return;
        const roll = toDeg(rotation.gamma);
        if (this.leanZero === null) this.leanZero = roll;
        emit({ timestamp: Date.now(), leanDeg: roll - this.leanZero });
      });
    }
  }

  /** Takes the current phone attitude as upright. */
  calibrate(): void {
    this.leanZero = null;
  }

  stop(): void {
    this.position?.remove();
    this.motion?.remove();
    this.position = null;
    this.motion = null;
  }
}
