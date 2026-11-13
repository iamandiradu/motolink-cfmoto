import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';

import type { MotionSample } from './lean';
import type { MetricsSample, MetricsSource } from './trip';

/** Motion readings per second. Enough to follow a corner, light on battery. */
const MOTION_INTERVAL_MS = 100;

/**
 * Metrics from the phone: GPS for speed, direction of travel, altitude and
 * position; motion sensors (gyroscope and accelerometer) to refine the lean
 * estimate between GPS fixes.
 */
export class PhoneSensorSource implements MetricsSource {
  readonly id = 'phone';
  private position: Location.LocationSubscription | null = null;
  private motion: { remove(): void } | null = null;

  async start(emit: (sample: MetricsSample) => void, emitMotion?: (sample: MotionSample) => void): Promise<void> {
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

    if (emitMotion && (await DeviceMotion.isAvailableAsync())) {
      DeviceMotion.setUpdateInterval(MOTION_INTERVAL_MS);
      this.motion = DeviceMotion.addListener((reading) => {
        const rate = reading.rotationRate;
        const gravity = reading.accelerationIncludingGravity;
        if (!rate || !gravity) return;
        emitMotion({
          timestamp: Date.now(),
          // expo-sensors names the axes alpha (z), beta (x), gamma (y), in degrees per second.
          rotationRate: { x: rate.beta, y: rate.gamma, z: rate.alpha },
          gravity: { x: gravity.x, y: gravity.y, z: gravity.z },
        });
      });
    }
  }

  stop(): void {
    this.position?.remove();
    this.motion?.remove();
    this.position = null;
    this.motion = null;
  }
}
