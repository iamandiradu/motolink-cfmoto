import { useAppState } from '../../app-state/store';
import { RidesScreen } from '../../rides';

export default function Rides() {
  const imperial = useAppState((s) => s.settings.units === 'imperial');
  return <RidesScreen imperial={imperial} />;
}
