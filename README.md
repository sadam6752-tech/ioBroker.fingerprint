![Logo](admin/fingerprint.png)

# ioBroker.fingerprint

Integrates the ESP32-based [FingerprintDoorbell](https://github.com/sadam6752-tech/FingerprintDoorbell)
into ioBroker over plain HTTP — **no MQTT and no simple-api adapter required**.

The adapter runs a small HTTP webhook receiver. The doorbell calls it directly on
a fingerprint match or an unknown-finger ring. The adapter also polls the device
to report its online/offline status and can reboot it or toggle the touch ring.

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

## States

| State | Type | Description |
|-------|------|-------------|
| `info.connection` | boolean | Device reachable (via `/debug` poll) |
| `info.uptime` | number | Device uptime in seconds |
| `info.freeHeap` | number | Free heap in bytes |
| `lastMatch.id` | number | ID of the last matched finger (1–200) |
| `lastMatch.name` | string | Name of the last matched finger |
| `lastMatch.confidence` | number | Match confidence |
| `lastMatch.timestamp` | number | Timestamp of the last match |
| `lastMatch.matched` | boolean | Set to true on each match event |
| `ring.ringing` | boolean | True for a few seconds on a doorbell ring |
| `ring.timestamp` | number | Timestamp of the last ring |
| `control.reboot` | boolean (button) | Reboot the device |
| `control.ignoreTouchRing` | boolean (switch) | Ignore the touch ring (firmware ≥ v0.9.1) |

## Firmware note

- **Match / Ring / Status / Reboot** work with FingerprintDoorbell **v0.9** as-is.
- **`control.ignoreTouchRing`** requires the firmware endpoint `GET /set-touch-ring?state=on|off`
  (planned for **v0.9.1**). Until then, the switch has no effect.

## Changelog

### 0.1.0

- Initial release: match/ring webhook receiver, ESP status polling, remote reboot and ignore-touch-ring control

## License

MIT License — Copyright (c) 2026 sadam6752-tech
