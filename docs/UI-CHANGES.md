# UI changes to review

Every change made to the app's screens during and after the three UI review rounds. Each has a number, where it is, what it was and what it is now.

❗ **To decide:** mark each row `keep` or `undo` in the last column, or just tell me the numbers to undo ("undo 9 and 12").

How the rounds were done: every tab was opened in the iOS Simulator and screenshotted, the colour contrast of every text and border colour was calculated for all dash themes, and touch-target sizes and accessibility labels were checked in the code.

## Round 1

| # | Where | Before | After | Decision |
| --- | --- | --- | --- | --- |
| 1 | Top of every screen | The dash picture had no label | Caption "Dash preview" above it | |
| 2 | Top of every screen, while mirroring | The preview kept showing the ride pages, though the dash was showing the phone screen | The preview folds away and one line says "Dash is showing your phone screen" | |
| 3 | Text fields and outline buttons | Border barely visible on the dark card (contrast 1.4:1) | Lighter border (3:1), so they read as controls | |
| 4 | Gray dash theme | Pink slightly too faint on panels (4.47:1) | Lighter pink, above 4.5:1 | |
| 5 | Dash, Ride page, no GPS | Speed showed two large white blocks | A dim dash | |
| 6 | Bottom tab bar | Mixed symbols; one turned into a coloured emoji | Forced to plain symbols (replaced by change 7) | |

## Round 2

| # | Where | Before | After | Decision |
| --- | --- | --- | --- | --- |
| 7 | Bottom tab bar | Odd symbols of uneven size and height | One icon set: arrows, gamepad, speedometer, map, gear | |
| 8 | Settings, order of groups | Connection first, Dash picture near the bottom | Dash picture, Spotify, Start when the bike connects, Connection, Bike, Share a report | |
| 9 | Settings, length | Every group open; a long scroll | Rarely used groups folded until tapped: "If the dash will not connect", "Add a bike someone shared", "Tips and setup guide", "Log" | |
| 10 | Dash, Ride page, no GPS | The dim dash still looked like a grey block | Smaller "- -" | |

## Round 3

| # | Where | Before | After | Decision |
| --- | --- | --- | --- | --- |
| 11 | Settings, captions above choices | Sentences ending in a full stop, such as "Units." | Bold labels: "Colours", "Units", "Picture quality", "When the app opens", "Dash generation" | |
| 12 | Settings → Connection | "Automatic" / "Manual" | "Connect by itself" / "Wait for me" | |
| 13 | Metrics, no GPS | "No data" repeated on five rows | One line "Waiting for GPS…" and a dash on each row | |
| 14 | Metrics → Reset trip | Reset at once | Asks "Reset trip?" first | |
| 15 | Link → Forget this bike | Forgot at once | Asks "Forget this bike?" first | |

## After the rounds

Changes made later, on request or while testing.

| # | Where | Before | After | Why | Decision |
| --- | --- | --- | --- | --- | --- |
| 16 | Above the dash preview | Only the small tabs inside the picture, about 10 pt tall on the phone | A row of full-size buttons: Ride, Map, Music, Trip, Menu (44 pt). Replaced the "Tap to try it" hint from change 1 | You reported the tabs were too small | |
| 17 | Any screen with a text field | The keyboard covered the field and the button below it | The screen scrolls the field above the keyboard; a button can be tapped while the keyboard is up | Found while pairing in the simulator | |
| 18 | Link → paste the QR link | Only the Pair button submitted | The keyboard's return key also submits | Same | |
| 19 | Link, while connecting | Only a status line | "Connection steps" card: each step with done / problem / waiting, and what to do where it is stuck | Recommended list | |
| 20 | Link, bike not reachable | Nothing | "Join the dash Wi-Fi" card with the network name and password to copy | Needed with a free Apple ID | |
| 21 | Bottom tab bar | Four tabs | Fifth tab, Rides | Ride log | |
| 22 | Settings | — | New groups: Language, Riding comfort, Testing, About, and Support MotoLink (hidden until donation links are set) | New features | |
| 23 | Dash, all pages | — | Warning bar at the bottom and a blinking frame for urgent warnings (speed, fuel, battery, lost link) | Riding comfort | |
| 24 | All phone buttons | Fixed size | Larger with glove mode on | Riding comfort | |
| 25 | Whole app | English only | English, Romanian, German, Italian, Spanish | Translations | |

## Colours

| Theme | Background | Focus colour | Highlight | Note |
| --- | --- | --- | --- | --- |
| Black, blue and pink (default) | Black | Blue `#00aeef` | Pink `#ff3d97` | Phone screens use the same black, blue and pink |
| Gray | `#30353a` | Light blue `#6fd0f7` | Light pink `#ffa3cd` | |
| Graphite | `#15171a` | Steel `#c9d0d7` | Blue `#00aeef` | |
| Neon green | Black | Neon green `#39ff14` | Lime `#d4ff3a` | Added on request |
| Daylight | `#f2f4f6` | Dark blue `#00709c` | Dark pink `#c2185b` | For direct sun |

The colour values are my own choice to match the CFMOTO look; they are not official brand codes.

## Wording to review (Romanian)

The translator marked these as uncertain. English in brackets.

- Dash tabs: "Tură" (Ride), "Parcurs" (Trip)
- Phone tabs: "Date" (Metrics), "Ture" (Rides)
- Service reminders: item names, and the word for "due"
- Short dash warnings for fuel and battery (they must stay within 18 characters)
- "Paused at a stop" on the Rides tab

German, Italian and Spanish have not been read by a native speaker.

## What has and has not been checked

- Changes 1 to 18 were seen in the iOS Simulator.
- Changes 19 to 25 were built and run, but each screen was not individually looked at in every language.
- Nothing here has been checked on the motorcycle's dash.
