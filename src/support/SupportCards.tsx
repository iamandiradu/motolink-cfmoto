import Constants from 'expo-constants';
import { useState } from 'react';
import { Linking } from 'react-native';

import { useT } from '../i18n';
import { Body, Button, Card } from '../ui/kit';
import { SOURCE_URL, activeSupportLinks } from './config';

/**
 * Voluntary support and the "about" notes. The Support card shows only when
 * at least one donation link is configured.
 */
export function SupportCards() {
  const t = useT();
  const links = activeSupportLinks();
  const [failed, setFailed] = useState(false);

  const open = (url: string) => {
    setFailed(false);
    Linking.openURL(url).catch(() => setFailed(true));
  };

  return (
    <>
      {links.length > 0 ? (
        <Card title={t('support.title')}>
          <Body dim>{t('support.body')}</Body>
          {links.map((link) => (
            <Button key={link.id} label={link.label} kind="plain" onPress={() => open(link.url)} />
          ))}
          <Body dim>{failed ? t('support.couldNotOpen') : t('support.thanks')}</Body>
        </Card>
      ) : null}

      <Card title={t('support.aboutTitle')} collapsible>
        <Body>{t('support.version', { version: Constants.expoConfig?.version ?? '?' })}</Body>
        <Body dim>{t('support.notAffiliated')}</Body>
        <Body dim>{t('support.disclaimer')}</Body>
        {SOURCE_URL ? <Button label={t('support.source')} kind="plain" onPress={() => open(SOURCE_URL)} /> : null}
      </Card>
    </>
  );
}
