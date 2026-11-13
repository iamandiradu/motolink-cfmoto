# Plan

Goal: an iPhone app that puts a useful picture on the CFMOTO 450 MT dash, driven by the handlebar buttons, connecting by itself after a one-time setup, and showing ride metrics.

## What the reference projects taught us

Seven repos were read. Four of them (zanderp/open-cfmoto, andpower/open-cfmoto-450nk, keriman/k1_open-cfmoto, ionutradu252/open-cflink, plus the archived dcoletto original) are the same Android app lineage and document the dash protocol. The other two are unrelated to the dash.

| Finding | Consequence for this app |
| --- | --- |
| The dash does not speak CarPlay. It speaks Carbit EasyConn ("PXC") over its own Wi-Fi. | Real Apple CarPlay cannot be shown. iOS only projects CarPlay to Apple-certified receivers. The app renders its own picture and streams it. |
| The Android apps show Android Auto by running a head-unit receiver on the phone. | No iOS equivalent exists. The dash UI (ride data, map, trip) is built in React Native instead. |
| Pairing is only the Wi-Fi name and password from the dash QR code. No token, no account. | Scan once, store the credentials, reconnect forever. |
| The phone is the TCP server (ports 10922, 10921, 10920). It probes dash:10930 and the dash dials back. | Implemented in `src/protocol` and the native module. |
| Video is H.264 Baseline 3.1, Annex-B, pulled one frame at a time, at the size the dash asks for. | Native encoder with VideoToolbox. |
| Handlebar buttons do not travel over Wi-Fi. The dash sends Bluetooth AVRCP: volume changes for the up/down rocker, media keys for select/next/previous. | Buttons are read from the system volume and the media remote commands. |
| No vehicle data leaves the bike without the T-Box. A dedicated investigation on a 450NK found nothing over Wi-Fi, BLE or the dash network. | Metrics come from the phone (GPS, motion). Engine data needs an OBD-II adapter; that is a later phase. |
| Nobody recorded the 450 MT's details (panel size, model id, which key each button sends). It is listed only as "community-confirmed, works with automatic settings". | The app reads the panel size from the dash at connect time and has a "find your buttons" screen. First ride is also the first capture. |
| `mobitouchOS/mt_carplay` is a Flutter CarPlay template plugin; `Beants/moto-carplay` is a Raspberry Pi plus CarPlay dongle script. | Neither applies. The dongle route is the only way to get genuine CarPlay pixels, and it is a hardware project. |

The Android projects are AGPL-3.0. Nothing was copied from them; this app is a fresh implementation of the protocol they documented.

## Requirements and how each is met

1. **Controlled by the motorcycle's buttons.** `ButtonBridge.swift` receives volume changes and media keys; `src/buttons/gestures.ts` turns them into gestures (press, double press); the dash UI moves a focus ring.
2. **Default layout, customizable.** `src/buttons/mapping.ts` holds the default layout; the Buttons tab remaps any gesture and can restore the default.
3. **Automatic connection after setup.** Credentials are saved after the first scan. The app asks iOS to join the dash Wi-Fi (and iOS rejoins a known network by itself), then `LinkSession` probes and reconnects in a loop, including after an ignition cycle.
4. **Motorcycle metrics.** Speed, heading, altitude, lean angle and a trip computer from the phone. `MetricsSource` is the seam for an OBD-II source.

## Architecture

```
React Native (TypeScript)
  src/protocol    wire format, handshake, session state machine   <- unit tested
  src/buttons     gesture detection, button layout                <- unit tested
  src/dash        dash UI state (reducer) and the dash picture    <- reducer unit tested
  src/metrics     trip computer, phone sensor source              <- trip computer unit tested
  src/app         phone screens (expo-router)

Native module (Swift, modules/moto-link)
  LinkServer      three TCP listeners, outbound probe, frame pull on 10920
  VideoEncoder    VideoToolbox H.264, AVCC to Annex-B
  FrameCapturer   snapshots the React Native dash view into the encoder
  RsaIdentity     throwaway RSA-1024 key for the handshake
  ButtonBridge    volume observer, media remote commands, silent audio
```

Protocol decisions live in TypeScript so they can be tested without a phone. The native side is transport only. The single exception is the video pull on port 10920: it runs at about 24 requests a second and is answered natively.

## Phases

| Phase | Content | State |
| --- | --- | --- |
| 0 | Read the reference repos, write this plan | Done |
| 1 | Protocol core, session, native transport, encoder | Written. TypeScript is unit tested; RSA and the encoder were run on macOS. Not yet run against a dash. |
| 2 | Buttons: capture, gestures, default layout, remapping | Written. Logic unit tested. Needs the bike to learn what the 450 MT sends. |
| 3 | Interface: dash pages (ride, map, trip, menu) and phone screens | Written. Not yet seen on a device. |
| 4 | IPA build on every merge to master | Workflow in `.github/workflows/build-ipa.yml` |
| 5 | First ride: capture the 450 MT's details, fix what the dash rejects | Next. Needs the bike. |
| 6 | Turn-by-turn navigation on the map page | Later |
| 7 | OBD-II Bluetooth adapter as a metrics source (rpm, coolant, battery) | Later. Needs an adapter on the diagnostic plug. |
| 8 | Picture while the phone is locked | Later. See risks. |

## Risks, most serious first

1. **Nothing has been run against the bike.** Every protocol fact comes from Android projects on other CFMOTO models. The 450 MT may differ.
2. **iOS background limits.** The dash picture is a live React Native view. iOS stops rendering and hardware video encoding when the app leaves the foreground. For now the app must stay open on screen, phone unlocked. The silent audio used for button capture keeps the process alive, which is a start, but a background-safe renderer is its own piece of work.
3. **Volume rocker on iOS.** Up/down arrive as system volume changes. To keep both directions usable the app puts the volume back to 50% after each press, through the slider inside `MPVolumeView`. That is not a public API. It can be switched off in the Buttons tab.
4. **Media keys cost the music.** To receive select/next/previous the app must be the active audio player, which pauses other music. "Up / down only" mode avoids that.
5. **Wi-Fi join entitlement.** Joining the dash network from the app needs the Hotspot Configuration entitlement, which a free Apple ID cannot sign. Without it, join the dash Wi-Fi once in iOS Settings; iOS rejoins it afterwards and the app takes over from there.
6. **The dash may treat an "iOS" phone differently.** The app introduces itself as the Android CFMOTO app, the identity known to work. A setting switches it.
7. **Wire format of video frames.** The Android authors mark the frame layout as inferred from decompiled code. It works on their bikes.

## What to capture on the first ride

The Settings tab has a log. After the first connection attempt it will show:

- the picture size the dash asked for,
- the dash software version,
- which notify frames the dash sends,
- on the Buttons tab, what each handlebar button produces.

With those four things the 450 MT gets a proper profile.
