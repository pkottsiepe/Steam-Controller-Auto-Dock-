import { SteamController } from './steamController'

export type NavState =
  | 'IDLE'
  | 'SCANNING'   // rotating 360°, sampling RSSI at each heading
  | 'ALIGNING'   // turning toward the heading with highest RSSI
  | 'MOVING'     // driving forward, monitoring RSSI
  | 'ARRIVED'    // RSSI threshold reached, waiting 1 s
  | 'SHIMMY'     // micro-adjustments to physically dock
  | 'FAILED'     // all shimmy phases exhausted without charging

export interface ScanPoint {
  heading: number   // radians, integrated from gyroZ
  rssi: number      // 0-255
}

// ±2000 dps at 16-bit: 2000/32768 deg/s per LSB → convert to rad/s
const GYRO_SCALE_RAD = (2000.0 / 32768.0) * (Math.PI / 180.0)

const TWO_PI = Math.PI * 2

// Haptic frequency for all movement commands (matches original repo)
const HAPTIC_HZ = 70

// Shimmy sequence: alternating left/right with increasing durations (ms)
const SHIMMY_DURATIONS = [2000, 2000, 3000, 3000, 4000, 4000, 5000, 5000]

// How many degrees of tolerance when aligning to the best heading
const ALIGN_TOLERANCE_RAD = 0.12  // ~7°

// RSSI drop (vs best seen) that triggers a re-scan during MOVING
const RSSI_DROP_THRESHOLD = 15

// Scan timeout fallback: if gyro doesn't detect 360° within this time, use collected data
const SCAN_TIMEOUT_MS = 15_000

export class Navigator {
  state: NavState = 'IDLE'
  heading = 0           // accumulated heading in radians (integrated gyroZ)
  targetHeading = 0     // heading toward best RSSI, set after scan
  scanPoints: ScanPoint[] = []
  arrivalRssiThreshold = 210  // configurable; call calibrateArrivalRSSI() when near puck
  lastCommand = ''      // exposed for UI

  private tickTimer: ReturnType<typeof setInterval> | null = null
  private lastTickMs = 0

  // — scan state —
  private scanStartHeading = 0
  private lastScanSampleMs = 0
  private scanStartMs = 0

  // — move state —
  private bestRssiSeen = 0
  private lastRssiCheckMs = 0

  // — arrival / shimmy state —
  private arrivalMs: number | null = null
  private shimmyStartMs: number | null = null
  private shimmyPhase = 0
  private shimmyLeft = true

  constructor(private readonly ctrl: SteamController) {}

  start() {
    if (this.state !== 'IDLE' && this.state !== 'FAILED') return
    this.heading = 0
    this.scanPoints = []
    this.lastCommand = ''
    this.lastTickMs = Date.now()
    this._setState('SCANNING')
    this.tickTimer = setInterval(() => this._tick(), 20)
  }

  stop() {
    this._clearTimer()
    this.ctrl.stopAll()
    this._setState('IDLE')
  }

  /** Call this while the controller is physically held over the charging puck */
  calibrateArrivalRSSI() {
    // Set threshold just below current RSSI so it triggers on arrival
    this.arrivalRssiThreshold = Math.max(30, this.ctrl.signalStrength - 10)
  }

  // ── Internal tick ──────────────────────────────────────────────────────

  private async _tick() {
    const now = Date.now()
    const dt = Math.min((now - this.lastTickMs) / 1000, 0.1)  // cap at 100 ms
    this.lastTickMs = now

    if (this.ctrl.eStop) {
      await this._send('STOP')
      return
    }

    // Terminal success conditions
    if (this.ctrl.isCharging === true || this.ctrl.batteryPercent >= 100) {
      await this._send('STOP')
      this._clearTimer()
      this._setState('IDLE')
      return
    }

    // Integrate gyroZ → yaw heading (vertical rotation on flat surface)
    this.heading += this.ctrl.imuData.gyroZ * GYRO_SCALE_RAD * dt

    switch (this.state) {
      case 'SCANNING':  await this._tickScan(now); break
      case 'ALIGNING':  await this._tickAlign(); break
      case 'MOVING':    await this._tickMove(now); break
      case 'ARRIVED':   await this._tickArrived(now); break
      case 'SHIMMY':    await this._tickShimmy(now); break
    }
  }

  // ── SCANNING ───────────────────────────────────────────────────────────

  private async _tickScan(now: number) {
    if (this.scanPoints.length === 0) {
      // First tick of scan: record start, begin rotating
      this.scanStartHeading = this.heading
      this.scanStartMs = now
      this.lastScanSampleMs = now
      this.scanPoints.push({ heading: this.heading, rssi: this.ctrl.signalStrength })
      await this._send('RIGHT')
      return
    }

    // Sample RSSI every 150 ms
    if (now - this.lastScanSampleMs >= 150) {
      this.scanPoints.push({ heading: this.heading, rssi: this.ctrl.signalStrength })
      this.lastScanSampleMs = now
    }

    // Done when we've rotated ≥ 360° (or timeout)
    const rotated = Math.abs(this.heading - this.scanStartHeading)
    const timedOut = now - this.scanStartMs >= SCAN_TIMEOUT_MS

    if (rotated >= TWO_PI || timedOut) {
      await this._send('STOP')
      const best = this.scanPoints.reduce((a, b) => (a.rssi >= b.rssi ? a : b))
      this.targetHeading = best.heading
      this._setState('ALIGNING')
    }
  }

  // ── ALIGNING ───────────────────────────────────────────────────────────

  private async _tickAlign() {
    const err = this._normalizeAngle(this.targetHeading - this.heading)

    if (Math.abs(err) <= ALIGN_TOLERANCE_RAD) {
      await this._send('STOP')
      this.bestRssiSeen = this.ctrl.signalStrength
      this.lastRssiCheckMs = Date.now()
      this._setState('MOVING')
      return
    }

    await this._send(err > 0 ? 'RIGHT' : 'LEFT')
  }

  // ── MOVING ─────────────────────────────────────────────────────────────

  private async _tickMove(now: number) {
    const rssi = this.ctrl.signalStrength

    if (rssi >= this.arrivalRssiThreshold) {
      await this._send('STOP')
      this.arrivalMs = now
      this._setState('ARRIVED')
      return
    }

    // Check RSSI every 500 ms; re-scan if signal drops significantly
    if (now - this.lastRssiCheckMs >= 500) {
      if (rssi > this.bestRssiSeen) this.bestRssiSeen = rssi

      const drop = this.bestRssiSeen - rssi
      if (drop > RSSI_DROP_THRESHOLD && this.bestRssiSeen > 30) {
        // We're heading away from the puck — re-scan
        await this._send('STOP')
        this.scanPoints = []
        this._setState('SCANNING')
        return
      }
      this.lastRssiCheckMs = now
    }

    await this._send('FORWARD')
  }

  // ── ARRIVED ────────────────────────────────────────────────────────────

  private async _tickArrived(now: number) {
    await this._send('STOP')
    if (this.arrivalMs !== null && now - this.arrivalMs >= 1000) {
      this.shimmyStartMs = now
      this.shimmyPhase = 0
      this.shimmyLeft = true
      this._setState('SHIMMY')
    }
  }

  // ── SHIMMY ─────────────────────────────────────────────────────────────

  private async _tickShimmy(now: number) {
    if (this.shimmyPhase >= SHIMMY_DURATIONS.length) {
      await this._send('STOP')
      this._setState('FAILED')
      return
    }

    const elapsed = now - (this.shimmyStartMs ?? now)
    if (elapsed >= SHIMMY_DURATIONS[this.shimmyPhase]) {
      this.shimmyStartMs = now
      this.shimmyPhase++
      this.shimmyLeft = !this.shimmyLeft
    }

    await this._send(this.shimmyLeft ? 'LEFT' : 'RIGHT')
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async _send(cmd: string) {
    if (cmd === this.lastCommand) return
    this.lastCommand = cmd
    if (cmd === 'STOP') {
      await this.ctrl.stopAll()
    } else if (cmd === 'FORWARD') {
      await this.ctrl.pulse(0, HAPTIC_HZ)
      await this.ctrl.pulse(1, HAPTIC_HZ)
    } else if (cmd === 'LEFT') {
      await this.ctrl.pulse(0, HAPTIC_HZ)
      await this.ctrl.stop(1)
    } else if (cmd === 'RIGHT') {
      await this.ctrl.stop(0)
      await this.ctrl.pulse(1, HAPTIC_HZ)
    }
  }

  private _setState(s: NavState) {
    this.state = s
  }

  private _clearTimer() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  private _normalizeAngle(a: number): number {
    while (a > Math.PI) a -= TWO_PI
    while (a < -Math.PI) a += TWO_PI
    return a
  }
}
