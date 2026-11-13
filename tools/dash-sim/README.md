# Dash simulator

**Read this first.** The simulator is built from the same reverse-engineering notes as the app
(the comments in `src/protocol`, `LinkServer.swift`, `RsaIdentity.swift` and `docs/PLAN.md`).
It checks the app against *our understanding* of the protocol, not against a real CFMOTO dash.
A PASS means the app does what the notes say. It does not mean a dash will accept the app.
If the notes are wrong, the app and the simulator can be wrong in the same way.

The dash side was written from the documented wire format, without importing or copying the
app's TypeScript. A slip in the app's encoder or parser therefore shows up as a FAIL here
rather than being repeated.

## Files

| File | What it is |
| --- | --- |
| `dash-sim.mjs` | The simulator. Plays the dash: answers the probe, dials back, runs the handshake, negotiates video, pulls and checks frames. |
| `phone-stub.mjs` | A minimal fake phone, used only to test the simulator. It can inject one known fault at a time. |
| `test.mjs` | Runs the simulator against the stub on loopback: one correct phone, one per fault. |

Needs Node 22 or later and nothing else. `ffmpeg` on PATH is optional: with it the simulator
also decodes the received stream and can save a PNG.

```sh
node tools/dash-sim/test.mjs                    # self-test, about 10 s
node tools/dash-sim/dash-sim.mjs --help         # every option
```

## How a run goes

The phone is the TCP server. The dash only listens on 10930 for one probe.

1. Listen on `--probe-port` (10930). Take one probe frame (`0x70000010`), check the 16-byte header,
   the XOR magic and the JSON (`phoneType`, `packageName`), then answer `0x70000011 {"status":true}`.
2. Dial back to the address the probe came from (or `--phone`).
   - Connection A on 10922: `0x10000` select, `0x10010` CLIENT_INFO, `0x10690` QUERY_SPEED.
   - Connection B on 10922: `0x20000` select, `0x103e0` CHECK_SN, then answer the phone's `0x201c0` with `0x201c1`.
   - `--profile cfdl26` only: the notify burst (`0x10780 0x103a0 0x10020 0x10040 0x10460 0x10450`),
     each of which must be acked with cmd+1 before media opens, and `0x10600` time sync every 2 s.
     The first sync carries an unset 1970 clock; the phone must write its current time into it.
3. Media control on 10921: CONFIG_CAPTURE (16), GET_VERSION (48), CONFIG_EXTEND (96), heartbeat (64), DATA_START (112).
4. Media data on 10920: pull with cmd 114 in strict lock-step at `--pull-fps` (24), read `[int32 LE size][Annex-B unit]`, check every unit.
5. After `--duration` seconds, print a summary table. Exit code 0 only if no check failed.

With `--drop-after N` the simulator plays an ignition cycle: it streams for N seconds, closes
every socket, stops answering on 10930 for `--off-time` seconds, then waits for the phone to probe
again and repeats the whole link (`--cycles`, default 2).

## (a) Against the app in the iOS Simulator, same Mac

> ❗ The app cannot reach the simulator yet. Make the app changes listed under
> "What the app needs" first.

```sh
node tools/dash-sim/dash-sim.mjs --bind 127.0.0.1 --out /tmp/dash.h264 --snapshot /tmp/dash.png
```

❗ In the app, set the dash address override to `127.0.0.1`, then start the link.

The app in the Simulator uses the Mac's network stack, so its listeners on 10922/10921/10920
are on the Mac. The simulator dials back to the address the probe came from (127.0.0.1).

## (b) Against a real iPhone on the same Wi-Fi

```sh
ipconfig getifaddr en0                            # the Mac's address, e.g. 192.168.1.23
node tools/dash-sim/dash-sim.mjs --out /tmp/dash.h264 --snapshot /tmp/dash.png
```

❗ In the app, set the dash address override to the Mac's address from `ipconfig`.

❗ When iOS asks for Local Network access for MotoLink, allow it. Without it every connection fails silently.

❗ If macOS asks whether `node` may accept incoming connections, allow it.

The simulator listens on all interfaces (`--bind 0.0.0.0`) and dials back to the iPhone's
address taken from the probe. Guest networks and some routers isolate Wi-Fi clients from each
other; use a network that does not, or the Mac's own hotspot.

## What the app needs before it can reach the simulator

> ❗ Each item below is a change to the app, outside `tools/dash-sim`.

1. **❗ A dash address override.** `LinkSession.attempt` probes `getNetworkInfo().gateway`
   (`WifiAddress.current()`: the en0 subnet with the last byte set to 1) and
   `fallbackDashAddress` (192.168.0.1 or 192.168.49.1). On a home network that is the router,
   never the Mac. Add a developer setting, for example `dashHost` in `SessionOptions`, that
   replaces that host list.
2. **❗ Skip the Wi-Fi gate when the override is set.** `attempt` returns early when
   `getNetworkInfo()` has no `ip`, and `WifiAddress.current()` only looks at `en0`. In the iOS
   Simulator that is the Mac's en0, which has no address on a Mac using Ethernet or a different
   interface name.
3. **❗ Relax `requiredInterfaceType = .wifi`** in `LinkServer.parameters()`. It applies to the
   three listeners *and* to the probe connection. Loopback in the iOS Simulator (and wired Ethernet
   on the Mac) is not Wi-Fi, so the probe will probably sit in `.waiting` (which `probe()` turns
   into an immediate failure) and the listeners may refuse the dial-back. Using
   `prohibitedInterfaceTypes = [.cellular]` keeps the original goal, staying off cellular,
   without excluding loopback. At minimum, drop the requirement when the override is set.
4. **❗ Turn off `autoJoinWifi` in this mode.** When no probe is accepted the session calls
   `joinWifi` with the stored bike credentials. On a signed build with the Hotspot entitlement
   that could move the phone off the network the Mac is on.
5. Ports. The simulator's defaults match the app's fixed ports (10930 and 10922/10921/10920), so
   no port override is needed for (a) or (b). The `--*-port` options exist for loopback testing
   with the stub.

## What each check means

| Check | Meaning |
| --- | --- |
| probe header / probe JSON | The 16-byte header is `cmd, totalLen, cmd^totalLen, 0` (little-endian) and the body is JSON with `phoneType` and `packageName`. A wrong magic gets no answer from a real dash. |
| CAR_CTRL / CAR_DATA select acked | The phone answers each channel select with cmd+1. |
| CLIENT_INFO reply has required keys | The `0x10011` JSON has `pxcVersion, phoneUUID, phoneOs, package, versionCode, pubkey, encryptedHUID, supportFunction`. Other usual keys missing is a WARN. |
| pubkey is base64 X.509 SubjectPublicKeyInfo RSA | `pubkey` is single-line base64 of a DER SubjectPublicKeyInfo holding an RSA key. A bare PKCS#1 key fails here. Not 1024 bits is a WARN. |
| encryptedHUID verifies against pubkey | RSA public-key "decrypt" with PKCS#1 v1.5 padding (Node `publicDecrypt`, `RSA_PKCS1_PADDING`) of `encryptedHUID` gives back the HUID the dash sent. |
| QUERY_SPEED acked | `0x10690` answered with `0x10691`. |
| CHECK_SN acked / CHECK_SN_RESULT | `0x103e1` ack, then `0x201c0` with `isOk: true` and the dash serial echoed in `id`. |
| notify 0x... acked (cfdl26) | Each notify frame is acked with cmd+1. If one is missing the simulator stops before media, like a newer dash that never opens the media ports. |
| phone writes current time into an unset (1970) dash clock (cfdl26) | The reply to a 1970 time sync carries the phone's local time (within 2 minutes). |
| time sync reply well formed (cfdl26) | `0x10601` is 45 bytes: int32 -2, channel, seq echoed, 0, and a 29-character `yyyy-MM-dd HH:mm:ss.SSS000000` stamp. An empty reply fails: it resets some dash clocks to 1970. |
| every time sync answered | No `0x10600` left without a reply for more than 3 s. |
| phone heartbeats on ctrl-A/B | Phone `0x70000000` frames seen on each control socket and the largest gap. With `--strict-heartbeat`, 7 s without one drops the link (sdk 0.9.23 behaviour). Without it, a gap over 7 s is a WARN. |
| phone answers dash heartbeats (`--dash-heartbeat`) | The simulator's own heartbeats get `0x70000001` back. |
| CONFIG_CAPTURE reply | 9 bytes: int32 encoder 2, int16 width and height each rounded down to a multiple of 16 (800x386 becomes 800x384), and the extend flag from body byte 29 echoed. The simulator sends 1 there so a phone that never reads it cannot pass by sending 0. |
| GET_VERSION / CONFIG_EXTEND / media heartbeat / DATA_START | Replies 49 (3,1), 97 (`{"state":0}`), 65, 113. |
| first frame after DATA_START is SPS+PPS+IDR | The first pulled unit contains NAL types 7, 8 and 5. A dash decoder cannot start on a P-frame. |
| SPS profile / level / size | `profile_idc` 66 (Baseline). The level is reported; above 3.1 is a WARN. The cropped picture size in the SPS equals the size the phone replied in CONFIG_CAPTURE. |
| video frames received | Frame count, measured fps, bitrate, keyframes and P-frames. |
| every frame is a valid Annex-B access unit | Each unit starts with a start code, no NAL is empty or has the forbidden bit set, and each holds a picture. An AVCC length prefix in place of a start code fails here. |
| video keeps flowing | No frame for `socketTimeoutPeriodWifi` seconds (9, from the dash's CLIENT_INFO, or `--frame-timeout`) drops the link, as a dash would. |
| later keyframes carry SPS+PPS | WARN when an IDR after the first comes without SPS/PPS. |
| ffmpeg decodes the stream without errors | Only with ffmpeg on PATH and `--out` or `--snapshot`. |
| phone re-probes after an ignition cycle | With `--drop-after`: the phone probes again within `--reconnect-timeout` once the dash comes back. |

`--verbose` hex-dumps every control and media frame, plus the first bytes of each video unit.
`--json` prints a JSON result on stdout and moves the human log to stderr.

To watch the stream: `ffplay -f h264 /tmp/dash.h264`, or open the file in VLC.

## What it cannot prove

- That a real dash agrees. Every byte layout here comes from notes on other CFMOTO models,
  mostly from decompiled Android code. The 450 MT may differ.
- The content of fields the notes do not describe: most of CONFIG_CAPTURE's body, the notify
  payloads, the CONFIG_EXTEND request and much of the CLIENT_INFO JSON are plausible filler.
  A phone that depends on them would pass here and could fail on the bike.
- Timing. A real dash may wait longer or shorter before dialling back, may open the two control
  connections in parallel, may pull faster or slower, and may never re-send a pull the phone
  did not answer. The app's `LinkServer` sends nothing when no frame is ready within 1.5 s, so the
  simulator re-pulls after 2 s; a real dash that does not would stall.
- Whether the picture looks right on the panel. The simulator checks that the stream is
  well formed and decodable, not what it shows.
- Anything outside the Wi-Fi link: joining the dash access point, the 192.168.0.1 addressing,
  Bluetooth buttons (AVRCP), touch, audio, and iOS background limits.
- The phone stub is not the app. `test.mjs` proves the simulator catches the faults it was
  written to catch. It says nothing about the app.
