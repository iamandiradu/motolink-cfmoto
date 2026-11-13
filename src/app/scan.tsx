import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { connect } from '../app-state/controller';
import { saveBike } from '../app-state/store';
import { parsePairingQr } from '../protocol/qr';
import { Body, Button, Card, colors } from '../ui/kit';

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [wrongCode, setWrongCode] = useState(false);
  const done = useRef(false);

  if (!permission?.granted) {
    return (
      <View style={styles.container}>
        <Card title="Camera access">
          <Body>The camera reads the QR code on the dash. Nothing is recorded.</Body>
          <Button label="Allow camera" onPress={() => void requestPermission()} />
        </Card>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          const bike = parsePairingQr(data);
          if (!bike) {
            setWrongCode(true);
            return;
          }
          done.current = true;
          saveBike(bike);
          connect();
          router.back();
        }}
      />
      <Card>
        <Body dim>
          {wrongCode
            ? 'That is a different QR code. Point at the one on the MotoPlay phone connection screen.'
            : 'Point the camera at the QR code on the dash.'}
        </Body>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 16, gap: 14 },
  camera: { flex: 1, borderRadius: 14, overflow: 'hidden' },
});
