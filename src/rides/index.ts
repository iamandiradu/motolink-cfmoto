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
