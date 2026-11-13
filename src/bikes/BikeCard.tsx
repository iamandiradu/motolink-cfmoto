/**
 * Shows which bike the app thinks it is talking to, what the dash reported,
 * and lets the rider pick the bike by hand. Presentational only: state and
 * side effects come in through props.
 */
import { StyleSheet, Text, View } from 'react-native';

import { Body, Button, Card, Choice, Row, colors } from '../ui/kit';
import { LearnedBike, workingIdentity } from './learned';
import { Confidence, ProfileMatch } from './match';
import { BikeProfile } from './profiles';

const AUTO = '__auto__';

const CONFIDENCE: Record<Confidence, { label: string; color: string }> = {
  certain: { label: 'Sure', color: colors.ok },
  likely: { label: 'Probably', color: colors.accent },
  guess: { label: 'Guess', color: colors.warn },
};

export interface BikeCardProps {
  match: ProfileMatch;
  learned: LearnedBike | null;
  profiles: readonly BikeProfile[];
  /** The rider's pick, null for automatic. */
  manualId: string | null;
  onChooseProfile: (id: string | null) => void;
  onShare: () => void;
  /** Hide the share button until something was learned. */
  canShare?: boolean;
}

function when(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleDateString() : '—';
}

export function BikeCard(props: BikeCardProps) {
  const { match, learned } = props;
  const confidence = CONFIDENCE[match.confidence];
  const capture = learned?.capture ?? null;
  const identity = workingIdentity(learned);
  const options = [
    { value: AUTO, label: 'Automatic' },
    ...props.profiles.map((p) => ({ value: p.id, label: p.name.replace(/^CFMOTO /, '') })),
  ];

  return (
    <Card title="Your bike">
      <View style={styles.header}>
        <Text style={styles.name}>{match.profile.name}</Text>
        <Text style={[styles.badge, { color: confidence.color, borderColor: confidence.color }]}>{confidence.label}</Text>
      </View>
      {match.reasons.length > 0 ? <Body dim>{match.reasons.join('. ')}.</Body> : null}
      {!match.profile.verified ? (
        <Body dim>No one has recorded this bike yet. The app learns it from your dash.</Body>
      ) : null}

      <Row label="Model id" value={learned?.modelId ?? '—'} />
      <Row label="Dash software" value={learned?.sdkVersion ?? '—'} />
      <Row label="Dash name" value={learned?.huName ?? '—'} />
      <Row label="Screen size" value={capture ? `${capture.deviceWidth} × ${capture.deviceHeight}` : '—'} />
      <Row label="Frame rate" value={capture ? `${capture.fps} fps` : '—'} />
      <Row
        label="Touch screen"
        value={learned?.supportScreenTouch == null ? '—' : learned.supportScreenTouch ? 'Yes' : 'No'}
      />
      <Row label="Settings that worked" value={identity ? `${identity.phoneOs}, ${identity.supportFunction}` : '—'} />
      <Row label="First seen" value={learned ? when(learned.firstSeen) : '—'} />
      <Row label="Last seen" value={learned ? when(learned.lastSeen) : '—'} />

      <Text style={styles.section}>Bike</Text>
      <Choice<string>
        value={props.manualId ?? AUTO}
        options={options}
        onChange={(value) => props.onChooseProfile(value === AUTO ? null : value)}
      />

      <Button
        label="Share bike details"
        kind="plain"
        disabled={props.canShare === false}
        onPress={props.onShare}
      />
      <Body dim>Shares sizes and versions only. No Wi-Fi password, serial or address.</Body>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  name: { color: colors.text, fontSize: 20, fontWeight: '700', flexShrink: 1 },
  badge: {
    fontSize: 13,
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  section: { color: colors.dim, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', marginTop: 6 },
});
