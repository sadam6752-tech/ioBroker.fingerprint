# Older Changelog

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
