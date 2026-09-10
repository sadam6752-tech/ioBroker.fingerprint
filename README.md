<img src="https://raw.githubusercontent.com/sadam6752-tech/ioBroker.fingerprint/main/admin/fingerprint.png" width="120" alt="FingerprintDoorbell logo" />

# ioBroker.fingerprint

Integrates the ESP32-based [FingerprintDoorbell](https://github.com/sadam6752-tech/FingerprintDoorbell)
into ioBroker over plain HTTP — **no MQTT and no simple-api adapter required**.

The adapter runs a small HTTP webhook receiver. The doorbell calls it directly on
a fingerprint match or an unknown-finger ring. The adapter also polls the device
to report its online/offline status and can reboot it or toggle the touch ring.

## Firmware requirement

This adapter talks to the **FingerprintDoorbell** firmware running on your ESP32.

- **Recommended: firmware v0.9.4 or newer** — everything below works, including
  enroll from the adapter, LED-ring control, WiFi signal and reliable
  multi-finger backup/restore.
- **firmware v0.9.3** — reliable backup/restore of all fingers (full 1536-byte
  templates).
- **firmware v0.9.1** — enables *server mode* (the adapter provisions the device
  automatically, no manual URLs) plus `control.ignoreTouchRing` and the fingerprint list.
- **firmware v0.9** also works in a basic mode (paste the match/ring URLs manually).

Feature-by-firmware overview:

| Feature | Firmware |
| --- | --- |
| Match / Ring / Status / Reboot | v0.9 |
| Server mode, ignore touch ring, fingerprint list | v0.9.1 |
| Backup / Restore (all fingers) | v0.9.3 |
| Enroll from adapter, LED ring, WiFi RSSI | v0.9.4 |

Get the firmware here:

- **Easiest — flash from your browser (fresh ESP32):**
  [Web Flasher](https://sadam6752-tech.github.io/FingerprintDoorbell/) — connect the ESP32
  via USB and click *Install* (Chrome/Edge/Opera or Firefox 151+).
- **Update later via OTA:** open `http://<device-ip>/update` → *Firmware* → upload
  `firmware.bin` from the [Releases](https://github.com/sadam6752-tech/FingerprintDoorbell/releases).
- **Manual download:** the latest ZIP from the
  [Releases](https://github.com/sadam6752-tech/FingerprintDoorbell/releases)
  (contains `firmware.bin`, `spiffs.bin` and flash instructions).

Check the running version at `http://<device-ip>/api/status` (field `version`).

## How it works

```
FingerprintDoorbell (ESP32)                 ioBroker.fingerprint
─────────────────────────                   ────────────────────
match  ──► HTTP GET /match?id=..  ─────────►  webhook receiver ──► lastMatch.*
ring   ──► HTTP GET /ring          ─────────►  webhook receiver ──► ring.*
                                    ◄───────  poll GET /debug   ──► info.connection
reboot                              ◄───────  GET /reboot        ◄── control.reboot
touch ring                          ◄───────  GET /set-touch-ring ◄── control.ignoreTouchRing
```

## Setup

1. Install and add an instance of the adapter.
2. In the instance settings, configure:
   - **Device IP Address** / **Device Port** — the doorbell's IP and WebUI port (default 80)
   - **Admin User / Admin Password** — if HTTP Basic Auth is enabled on the device
   - **Webhook Bind IP / Webhook Port** — where the adapter listens (default `0.0.0.0:8095`)
3. In the **FingerprintDoorbell WebUI → Settings**, set the HTTP action URLs to point
   to this adapter (copy the ready-made URLs from the instance settings — they already
   include the webhook token; replace `<iobroker-ip>` with the ioBroker host IP):

   ```
   HTTP Match URL: http://<iobroker-ip>:8095/match?id={id}&name={name}&confidence={confidence}&token=<token>
   HTTP Ring URL:  http://<iobroker-ip>:8095/ring?token=<token>
   ```

## Security

Communication is authenticated in both directions:

- **Adapter → device** (status poll, reboot, touch ring): HTTP Basic Auth using the
  configured Admin User / Admin Password.
- **Device → adapter** (match/ring webhooks): a shared **webhook token**. The token is
  auto-generated on first start and shown in the instance settings. Requests without a
  valid token (via `token` query parameter or `X-Auth-Token` header) are rejected with
  HTTP 401. Optionally, enable *"Accept webhooks only from the device IP"* to also reject
  requests from any other host.

With firmware < v0.9.1 the token must be pasted manually into the device URLs. From
v0.9.1 (server mode), the adapter provisions the URLs and token automatically.

## Fingerprint Actions (no scripting)

The **Fingerprint Actions** tab lets you trigger ioBroker objects directly from a
fingerprint — no JavaScript needed:

1. Click **Load fingerprints from device** to fill the table with the enrolled fingers
   (id + name). Existing rows are kept (merge).
2. For each row choose a **Target object**, an **Action** (`Set value` or `Toggle`),
   a **Value** and an optional **Min confidence** (leave empty to ignore).
3. The **Value** is freely typed and coerced to the target object's type:
   - boolean target: `true`, `1`, `on`, `yes`, `ja`, `да` → true; anything else → false
   - number target: parsed as a number (`,` accepted as decimal separator)
   - string target: used as-is
4. **Ring action** sets a chosen object when an unknown finger rings (e.g. play a chime).

### Smart rules (v0.5.0)

- **Debounce (s)** — ignore repeated triggers of the same finger within N seconds.
- **Conditions** checkbox — enforce time-based access windows for that finger. Define the
  windows on the **Conditions** tab: enter one or more finger IDs (comma-separated, e.g.
  `1,2,4`), tick the weekdays and set a `From`/`To` time (`HH:MM`). Multiple rows for the same finger are OR-combined; time ranges may cross
  midnight (e.g. `22:00`–`06:00`). If Conditions is on but no row matches, the action is skipped.
- **Alarm** checkbox (panic finger) — in addition to the normal action, sets the object
  configured under **Alarm target**. Example: a special finger opens the door as usual and
  also triggers an alarm state.
- **Snapshot** checkbox — in addition to the normal action, sets the object configured under
  **Snapshot target**. Example: trigger a script that captures an ESP32-CAM snapshot and sends it.

## Manage Fingers (v0.6.0)

The **Manage Fingers** tab lets you administer fingers without opening the device WebUI:

- **Rename** — enter a finger ID and a new name, then click *Rename*.
- **Create backup** — downloads all fingerprint templates from the sensor and stores them in
  a file on the ioBroker host (`<iobroker-data>/fingerprint.0/fingerprints-backup.json`),
  which survives adapter updates.
- **Restore from backup** — writes the fingerprints from that file back to the sensor.

Save the instance settings first so the device connection is available.

> **Note:** reliable backup/restore of *all* fingers needs firmware **v0.9.4**
> (full 1536-byte templates). Backups made with older firmware are incomplete —
> re-create them after updating.

## Enroll a new finger (v0.7.0, firmware ≥ v0.9.4)

You can enroll a new fingerprint directly from ioBroker — no need to open the
device WebUI:

- **Admin UI:** *Manage Fingers* tab → *Enroll a new finger* → enter a free ID
  (1–200) and a name → **Start enrollment**.
- **States:** write `control.enrollId` and `control.enrollName`, then set
  `control.enrollStart` = `true`.

Enrollment runs on the device and needs the user to place the finger on the
sensor **5 times**. Progress is reported live in the `enroll` channel:

| State | Type | Description |
| --- | --- | --- |
| `enroll.active` | boolean | `true` while an enrollment is running |
| `enroll.step` | number | Current scan step (0–5) |
| `enroll.status` | string | `idle` / `scanning` / `success` / `error` |
| `enroll.message` | string | Last human-readable status line |

On success the fingerprint list is refreshed automatically.

## LED ring control (v0.7.0, firmware ≥ v0.9.4)

Control the sensor's RGB ring from ioBroker:

- `control.ledMode` — `0` off, `1` on, `2` breathing, `3` flashing
- `control.ledColor` — `1` red, `2` blue, `3` purple, `4` green, `5` yellow, `6` cyan, `7` white

Writing either state applies the ring immediately.

## States

| State | Type | Description |
|-------|------|-------------|
| `info.connection` | boolean | Device reachable (via `/api/status` or `/debug` poll) |
| `info.uptime` | number | Device uptime in seconds |
| `info.freeHeap` | number | Free heap in bytes |
| `info.firmwareVersion` | string | Device firmware version |
| `info.serverMode` | boolean | Device sends events directly to this adapter |
| `info.wifiRssi` | number | WiFi signal strength in dBm (firmware ≥ v0.9.4) |
| `fingerprints.<id>.name` | string | Name of the enrolled finger with that ID |
| `fingerprints.<id>.lastSeen` | number | Timestamp the finger was last matched |
| `fingerprints.<id>.count` | number | How often the finger was matched |
| `lastAccess.text` | string | Readable last access entry (granted/denied) |
| `lastAccess.granted` | boolean | Whether the last access was granted |
| `lastAccess.timestamp` | number | Timestamp of the last access |
| `stats.totalMatches` | number | Total fingerprint matches |
| `stats.totalRings` | number | Total doorbell rings (unknown finger) |
| `stats.lastPerson` | string | Name of the last recognized person |
| `lastMatch.id` | number | ID of the last matched finger (1–200) |
| `lastMatch.name` | string | Name of the last matched finger |
| `lastMatch.confidence` | number | Match confidence |
| `lastMatch.timestamp` | number | Timestamp of the last match |
| `lastMatch.matched` | boolean | Set to true on each match event |
| `ring.ringing` | boolean | True for a few seconds on a doorbell ring |
| `ring.timestamp` | number | Timestamp of the last ring |
| `control.reboot` | boolean (button) | Reboot the device |
| `control.ignoreTouchRing` | boolean (switch) | Ignore the touch ring (firmware ≥ v0.9.1) |
| `control.enrollId` | number | Slot id (1–200) for the next enrollment (firmware ≥ v0.9.4) |
| `control.enrollName` | string | Name for the next enrollment (firmware ≥ v0.9.4) |
| `control.enrollStart` | boolean (button) | Start enrollment (firmware ≥ v0.9.4) |
| `control.ledMode` | number | LED ring mode 0–3 (firmware ≥ v0.9.4) |
| `control.ledColor` | number | LED ring color 1–7 (firmware ≥ v0.9.4) |
| `enroll.active` | boolean | Enrollment running (firmware ≥ v0.9.4) |
| `enroll.step` | number | Current enrollment scan step 0–5 |
| `enroll.status` | string | `idle` / `scanning` / `success` / `error` |
| `enroll.message` | string | Last enrollment status line |

## Firmware note

- **Match / Ring / Status / Reboot** work with FingerprintDoorbell **v0.9** as-is.
- **`control.ignoreTouchRing`**, server mode and the fingerprint list require **v0.9.1**.
- **Backup / Restore** of all fingers requires **v0.9.3** (full 1536-byte templates).
- **Enroll from adapter, LED ring, `info.wifiRssi`** require **v0.9.4**.

## Changelog

### 0.7.0

- **Enroll from the adapter** (firmware ≥ v0.9.4): start enrollment from the *Manage Fingers*
  tab or via `control.enrollStart`; live progress in the `enroll` channel
  (`active` / `step` / `status` / `message`)
- **LED ring control** (firmware ≥ v0.9.4): `control.ledMode` + `control.ledColor`
- **WiFi signal**: new `info.wifiRssi` state (firmware ≥ v0.9.4)
- **Conditions**: added an *Available fingers* reference dropdown (id → name) so you know
  which IDs to enter

### 0.6.1

- Fix invalid jsonConfig: remove unsupported `attr` from the Manage Fingers rename fields (settings page failed to load)

### 0.6.0

- **Manage Fingers** tab: rename a finger, and backup / restore all fingerprints
  (stored in a file on the ioBroker host that survives adapter updates)
- **Snapshot** action: per-rule checkbox + a *Snapshot target* object — set in addition
  to the normal action, e.g. to trigger a script that captures an ESP32-CAM snapshot

### 0.5.1

- Conditions: the Finger field accepts several IDs comma-separated (e.g. `1,2,4`); added a hint/tooltip

### 0.5.0

- Smart rules for Fingerprint Actions:
  - **Debounce** (seconds) per rule — ignore repeated triggers of the same finger
  - **Time-based conditions** (new *Conditions* tab): allow a finger only on selected
    weekdays within a time range (OR-combined, may cross midnight); enable via the
    *Conditions* checkbox per rule
  - **Alarm / panic finger**: extra *Alarm* checkbox per rule sets an additional alarm
    object (configured under *Alarm target*) on top of the normal action

### 0.4.1

- Docs: use an absolute logo URL in README so it shows on the npm package page

### 0.4.0

- Access log & history: optional access logging (checkbox), `lastAccess.*` and `stats.*` states
- Per-finger history: `fingerprints.<id>` is now a channel with `name`, `lastSeen`, `count`
  (the old flat `fingerprints.<id>` state is migrated automatically)

### 0.3.4

- Docs: correct Web Flasher browser support — Firefox 151+ now supports Web Serial

### 0.3.3

- Docs: add browser-based Web Flasher link (ESP Web Tools) for flashing a fresh ESP32

### 0.3.2

- Docs: direct download link to the FingerprintDoorbell v0.9.1 firmware release

### 0.3.1

- Docs: firmware requirement section with download/flash instructions (link to FingerprintDoorbell v0.9.1 release)

### 0.3.0

- New "Fingerprint Actions" tab: map each finger to an ioBroker object (set/toggle, value, min confidence)
- Ring action for the unknown-finger event
- "Load fingerprints from device" button (merges with existing rules)
- Value coercion to the target object's type (boolean/number/string)

### 0.2.3

- Test Connection shows a plain message instead of the raw translation object; remove diagnostics log

### 0.2.2

- Fix Test Connection: enable messagebox so the adapter receives sendTo messages

### 0.2.0

- Server mode auto-provisioning (firmware v0.9.1): adapter registers itself on the device via `/api/register-server`
- Status polling switched to JSON `/api/status` (with `/debug` fallback for v0.9)
- Working `control.ignoreTouchRing` via `/set-touch-ring`
- Fingerprint list sync into `fingerprints.<id>` objects
- New states `info.firmwareVersion`, `info.serverMode`
- New "Adapter Host/IP" setting (auto-detected if empty)

### 0.1.3

- Fix Test Connection timeout: read config directly (no jsonData), guard against hanging requests, add hint to save settings first

### 0.1.2

- Fix Test Connection button: return localized result/error and add spinner + request timeout

### 0.1.1

- Fix invalid jsonConfig: remove unsupported `showProcessState` from the Test Connection button

### 0.1.0

- Initial release: match/ring webhook receiver, ESP status polling, remote reboot and ignore-touch-ring control

## License

MIT License — Copyright (c) 2026 sadam6752-tech
