/**
 * Shows which bike the app thinks it is talking to, what the dash reported,
 * and lets the rider pick the bike by hand. Presentational only: state and
 * side effects come in through props.
 */
import { StyleSheet, Text, View } from 'react-native';

import { useT } from '../i18n';
import { Body, Button, Card, Choice, Row, colors } from '../ui/kit';
import { LearnedBike, workingIdentity } from './learned';
import { Confidence, ProfileMatch } from './match';
import { BikeProfile } from './profiles';

const AUTO = '__auto__';

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  certain: colors.ok,
  likely: colors.accent,
  guess: colors.warn,
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
  const t = useT();
  const { match, learned } = props;
  const confidence = { label: t(`bike.confidence.${match.confidence}`), color: CONFIDENCE_COLOR[match.confidence] };
  const capture = learned?.capture ?? null;
  const identity = workingIdentity(learned);
  const options = [
    { value: AUTO, label: t('bike.automatic') },
    ...props.profiles.map((p) => ({ value: p.id, label: p.name.replace(/^CFMOTO /, '') })),
  ];

  return (
    <Card title={t('bike.title')}>
      <View style={styles.header}>
        <Text style={styles.name}>{match.profile.name}</Text>
        <Text style={[styles.badge, { color: confidence.color, borderColor: confidence.color }]}>{confidence.label}</Text>
      </View>
      {match.reasons.length > 0 ? <Body dim>{match.reasons.join('. ')}.</Body> : null}
      {!match.profile.verified ? (
        <Body dim>{t('bike.notVerified')}</Body>
      ) : null}

      <Row label={t('bike.modelId')} value={learned?.modelId ?? '—'} />
      <Row label={t('bike.dashSoftware')} value={learned?.sdkVersion ?? '—'} />
      <Row label={t('bike.dashName')} value={learned?.huName ?? '—'} />
      <Row label={t('bike.screenSize')} value={capture ? `${capture.deviceWidth} × ${capture.deviceHeight}` : '—'} />
      <Row label={t('bike.frameRate')} value={capture ? t('bike.fps', { fps: capture.fps }) : '—'} />
      <Row
        label={t('bike.touch')}
        value={learned?.supportScreenTouch == null ? '—' : learned.supportScreenTouch ? t('common.yes') : t('common.no')}
      />
      <Row label={t('bike.worked')} value={identity ? `${identity.phoneOs}, ${identity.supportFunction}` : '—'} />
      <Row label={t('bike.firstSeen')} value={learned ? when(learned.firstSeen) : '—'} />
      <Row label={t('bike.lastSeen')} value={learned ? when(learned.lastSeen) : '—'} />

      <Text style={styles.section}>{t('bike.section')}</Text>
      <Choice<string>
        value={props.manualId ?? AUTO}
        options={options}
        onChange={(value) => props.onChooseProfile(value === AUTO ? null : value)}
      />

      <Button
        label={t('bike.share')}
        kind="plain"
        disabled={props.canShare === false}
        onPress={props.onShare}
      />
      <Body dim>{t('bike.shareNote')}</Body>
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
