import * as Location from 'expo-location';

import type { MetricsSample, MetricsSource } from './trip';

/** Metrics from the phone's GPS: speed, direction of travel, altitude, position. */
export class PhoneSensorSource implements MetricsSource {
  readonly id = 'phone';
  private position: Location.LocationSubscription | null = null;

  async start(emit: (sample: MetricsSample) => void): Promise<void> {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return;
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

  stop(): void {
    this.position?.remove();
    this.position = null;
  }
}
