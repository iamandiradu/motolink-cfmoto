/** Public API of the ride log. Import from 'src/rides', not from the files inside. */
export { RidesScreen, type RidesScreenProps } from './RidesScreen';
export {
  deleteSavedRide,
  exportRide,
  feedSample,
  getRidesState,
  isRecording,
  refreshRides,
  startRecording,
  stopRecording,
  subscribeRides,
  useRides,
  type RidesState,
  type StopResult,
} from './session';
export { RideRecorder, DEFAULT_THINNING, type LiveRide, type Ride, type RidePoint, type RideSummary, type ThinningOptions } from './recorder';
export { defaultRideName, escapeXml, gpxFileName, isoUtc, toGpx } from './gpx';
export { shareRideGpx, type ShareResult } from './share';
export { MAX_RIDES, deleteRide, listRides, loadRide, saveRide } from './storage';
export { RideDetail, type RideDetailProps } from './RideDetail';
export { StatsCard, type StatsCardProps } from './StatsCard';
export { ServiceCard, type ServiceCardProps } from './ServiceCard';
export { MOVING_THRESHOLD_KMH } from './recorder';
export {
  BAND_COLORS,
  regionForTrack,
  speedBands,
  speedLegend,
  type LatLng,
  type Region,
  type SpeedBand,
  type SpeedBandsResult,
  type SpeedSegment,
} from './track';
export { monthlyBuckets, rideStats, rideTotals, type MonthBucket, type RideStats, type RideTotals } from './stats';
export {
  DEFAULT_SERVICE_ITEMS,
  SOON_FRACTION,
  addDistance,
  addRide,
  defaultServiceState,
  dueItems,
  markDone,
  serviceStatuses,
  setOdometer,
  setServiceInterval,
  statusOf,
  type ServiceItem,
  type ServiceItemStatus,
  type ServiceState,
  type ServiceStatus,
} from './service';
export {
  addRideToService,
  addServiceDistance,
  getServiceSnapshot,
  loadServiceState,
  markServiceDone,
  refreshService,
  setServiceItemInterval,
  setServiceOdometer,
  subscribeService,
  useService,
} from './serviceStore';
