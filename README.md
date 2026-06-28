# Steam Controller Auto-Dock

A browser-based tool that autonomously navigates a Steam Controller to its wireless charging puck using WebHID, RSSI-based direction-finding, and gyroscope heading integration.

## How It Works

1. **Scan** — the controller rotates 360° while sampling RSSI signal strength at each heading
2. **Align** — turns toward the direction with the strongest signal
3. **Move** — drives forward, monitoring RSSI and re-scanning if signal drops
4. **Shimmy** — fine-alignment via alternating left/right micro-movements to physically seat on the puck

## Features

- **WebHID** connection — no drivers or native app required; runs entirely in the browser
- **Live compass** — real-time gyro heading display (canvas, 60 fps)
- **Polar RSSI plot** — visual scan map showing signal strength in all directions
- **Smoothed signal bar** — rolling average of last 30 readings with trend indicator (↑ ↓ →)
- **Manual d-pad** — override control at any time
- **E-STOP** — immediately halts all haptic motor output
- **Calibrate** — sets arrival threshold from current RSSI when held over the puck

## Requirements

- A browser with **WebHID support** (Chrome / Edge 89+; not Firefox/Safari)
- Steam Controller (wireless dongle) paired via USB

## Setup

```bash
npm install
npm run dev
```

Open `http://localhost:5173`, click **Connect Controller (WebHID)**, select your Steam Controller dongle, then click **Start Auto-Dock**.

## Build

```bash
npm run build
```

Output goes to `dist/`.

## Technical Notes

### RSSI Source
Signal strength is read from HID Report `0x43`, byte 2 (0–255, higher = closer to puck).

### Gyro Integration
`gyroZ` (vertical yaw axis when controller is flat) is integrated at each navigation tick to accumulate heading. Scale assumes ±2000 dps at 16-bit (`GYRO_SCALE_RAD` in `navigator.ts`).

### IMU Enable
On connect, the app sends Feature Report `0x87` with `SETTING_GYRO_MODE = 0x30`, value `0x16` to enable raw accelerometer + gyroscope output. Without this command the Steam Controller does not include IMU data in input reports.

### Haptic Motors
Movement is driven by the haptic actuators (left pad = motor 0, right pad = motor 1) via Reports `0x83` (Triton 2026) and `0x8F` (original SC fallback). Forward = both motors, Left/Right = one motor.

### Byte Layout (Report `0x45`, 53 bytes)
```
Bytes 17–52: 3 × IMU samples (12 bytes each)
Each sample: [accelX, accelY, accelZ, gyroX, gyroY, gyroZ] as int16 LE
```
If gyro values remain zero after connecting, the byte offset (`IMU_BASE` in `steamController.ts`) may need adjustment for your firmware version — expand the Debug panel and inspect the `Raw[0..31]` hex dump.

## Stack

- [Vue 3](https://vuejs.org/) + `<script setup>` Composition API
- [Vite](https://vitejs.dev/)
- TypeScript
- WebHID API (no external dependencies for hardware access)
