// WebHID: event.data does NOT include the report ID byte.
// event.reportId carries the ID; data[0] is the first payload byte.

export interface IMUData {
  gyroX: number   // raw int16, axis perpendicular to controller face (roll)
  gyroY: number   // raw int16, axis along controller length (pitch)
  gyroZ: number   // raw int16, vertical axis when flat on table (yaw) — used for navigation
  accelX: number
  accelY: number
  accelZ: number
  timestamp: number
}

// Triton 2026 main input report structure (bytes 17-52 per spec, 0-indexed in WebHID data):
// 3 samples × 12 bytes each = 36 bytes
// Each sample: [accelX, accelY, accelZ, gyroX, gyroY, gyroZ] as int16 LE
const IMU_BASE = 17
const IMU_SAMPLE_SIZE = 12
const IMU_SAMPLES = 3

function toInt16(lo: number, hi: number): number {
  const v = lo | (hi << 8)
  return v >= 0x8000 ? v - 0x10000 : v
}

export class SteamController {
  private devices: HIDDevice[] = []
  private activeChannels = new Map<number, number>()  // channel → frequency
  private pulseInterval: ReturnType<typeof setInterval> | null = null

  public isCharging: boolean | null = null
  public batteryPercent: number = 0
  public batteryVoltage: number = 0
  public signalStrength: number = 0   // from Report 0x43 byte 2; higher = closer to puck
  public eStop: boolean = false
  public imuData: IMUData = {
    gyroX: 0, gyroY: 0, gyroZ: 0,
    accelX: 0, accelY: 0, accelZ: 0,
    timestamp: 0,
  }

  // Raw report log for debugging unknown report IDs
  public lastReportId: number = 0
  public lastReportLength: number = 0
  public lastRawReport: Uint8Array = new Uint8Array(0)

  private hasProbed = false

  private handleReport(event: HIDInputReportEvent) {
    const data = new Uint8Array(event.data.buffer)
    this.lastReportId = event.reportId
    this.lastReportLength = data.length
    if (event.reportId === 0x45 || event.reportId === 1 || event.reportId === 0x42) {
      this.lastRawReport = data
    }

    // Triton 2026 System Status: battery, voltage, signal strength
    if (event.reportId === 67 /* 0x43 */) {
      this.batteryPercent = data[1]
      this.signalStrength = data[2]
      this.batteryVoltage = data[4] | (data[5] << 8)

      // On first valid voltage, probe for charging state via register 0x4E
      if (!this.hasProbed && this.batteryVoltage > 0) {
        this.hasProbed = true
        const payload = new Uint8Array(64)
        payload[0] = 0x4e  // SETTING_DEVICE_POWER_STATUS
        for (const d of this.devices) {
          if (d.opened) d.sendFeatureReport(0x89, payload).catch(() => {})
        }
      }
    }

    // Charging status response
    if (event.reportId === 121 /* 0x79 */) {
      this.isCharging = data[0] === 2
    }

    // Main input report — contains 3 IMU samples at bytes 17-52
    // Triton 2026 uses report IDs 0x01, 0x42 ('B'), or 0x45 ('E') per spec naming
    if (
      (event.reportId === 1 || event.reportId === 0x42 || event.reportId === 0x45) &&
      data.length >= IMU_BASE + IMU_SAMPLES * IMU_SAMPLE_SIZE
    ) {
      // Use the freshest (last) sample
      const o = IMU_BASE + (IMU_SAMPLES - 1) * IMU_SAMPLE_SIZE
      this.imuData = {
        accelX: toInt16(data[o + 0], data[o + 1]),
        accelY: toInt16(data[o + 2], data[o + 3]),
        accelZ: toInt16(data[o + 4], data[o + 5]),
        gyroX:  toInt16(data[o + 6], data[o + 7]),
        gyroY:  toInt16(data[o + 8], data[o + 9]),
        gyroZ:  toInt16(data[o + 10], data[o + 11]),
        timestamp: Date.now(),
      }
    }
  }

  async connect(): Promise<boolean> {
    try {
      const nav = navigator as unknown as { hid?: HID }
      if (!nav.hid) return false
      const selected = await nav.hid.requestDevice({ filters: [{ vendorId: 0x28de }] })
      if (selected.length === 0) return false
      return this.autoConnect()
    } catch {
      return false
    }
  }

  async autoConnect(): Promise<boolean> {
    try {
      const nav = navigator as unknown as { hid?: HID }
      if (!nav.hid) return false
      const paired = await nav.hid.getDevices()

      // The dongle exposes multiple interfaces — broadcast to all vendor-specific ones
      let targets = paired.filter(d =>
        d.collections?.some(c => c.usagePage === 0xff00)
      )
      if (targets.length === 0 && paired.length > 0) targets = [paired[0]]
      if (targets.length === 0) return false

      this.devices = targets
      for (const device of this.devices) {
        if (!device.opened) {
          try { await device.open() } catch { /* may already be open */ }
        }
        device.addEventListener('inputreport', this.handleReport.bind(this))
      }
      await this.enableIMU()
      return true
    } catch {
      return false
    }
  }

  private async enableIMU() {
    // Steam Controller SET_SETTINGS (0x87): enable raw accel (0x02) + raw gyro (0x04) + orientation (0x10)
    const p = new Uint8Array(64)
    p[0] = 0x03   // 3 bytes of settings data follow
    p[1] = 0x30   // SETTING_GYRO_MODE register
    p[2] = 0x16   // SEND_RAW_ACCEL | SEND_RAW_GYRO | SEND_ORIENTATION
    p[3] = 0x00
    for (const d of this.devices) {
      if (d.opened) d.sendFeatureReport(0x87, p).catch(() => {})
    }
  }

  async disconnect() {
    this.stopAllChannels()
    for (const d of this.devices) {
      try { await d.close() } catch { /* ignore */ }
    }
    this.devices = []
    this.hasProbed = false
  }

  // ── Haptic / movement ────────────────────────────────────────────────────

  async pulse(channel: number, frequency: number) {
    if (this.devices.length === 0 || this.eStop) return
    this.activeChannels.set(channel, frequency)
    this._startPulseLoop()
    await this._sendPulse(channel, frequency)
  }

  async stop(channel: number) {
    if (this.devices.length === 0) return
    this.activeChannels.delete(channel)
    if (this.activeChannels.size === 0) this._stopPulseLoop()
    await this._sendStop(channel)
  }

  async stopAll() {
    this._stopPulseLoop()
    this.activeChannels.clear()
    for (let i = 0; i < 4; i++) await this._sendStop(i)
  }

  private _startPulseLoop() {
    if (this.pulseInterval) return
    this.pulseInterval = setInterval(() => {
      if (this.eStop) { this.stopAll(); return }
      this.activeChannels.forEach((freq, ch) => this._sendPulse(ch, freq))
    }, 50)
  }

  private _stopPulseLoop() {
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval)
      this.pulseInterval = null
    }
  }

  // Collapses all internal channel bookkeeping
  private stopAllChannels() {
    this._stopPulseLoop()
    this.activeChannels.clear()
  }

  private async _sendPulse(channel: number, frequency: number) {
    const mappedChannel = channel < 2 ? (channel === 0 ? 4 : 3) : channel - 2
    const gainByte = (200 - 128) & 0xff

    // Triton 2026 — Report 0x83
    const data83 = new Uint8Array(9)
    data83[0] = mappedChannel
    data83[1] = gainByte
    data83[2] = frequency & 0xff
    data83[3] = (frequency >> 8) & 0xff
    data83[4] = 0xff
    data83[5] = 0x7f
    for (const d of this.devices) {
      if (d.opened) d.sendReport(0x83, data83).catch(() => {})
    }

    // Original Steam Controller fallback — Report 0x8F (period-based)
    const period = Math.floor(495483 / frequency)
    const data8F = new Uint8Array(63)
    data8F[1] = channel
    data8F[2] = period & 0xff
    data8F[3] = (period >> 8) & 0xff
    data8F[4] = period & 0xff
    data8F[5] = (period >> 8) & 0xff
    data8F[6] = 0xff
    data8F[7] = 0x7f
    for (const d of this.devices) {
      if (d.opened) d.sendReport(0x8f, data8F).catch(() => {})
    }
  }

  private async _sendStop(channel: number) {
    const mappedChannel = channel < 2 ? (channel === 0 ? 4 : 3) : channel - 2

    const data83 = new Uint8Array(9)
    data83[0] = mappedChannel
    for (const d of this.devices) {
      if (d.opened) d.sendReport(0x83, data83).catch(() => {})
    }

    const data81 = new Uint8Array(7)
    data81[0] = mappedChannel
    for (const d of this.devices) {
      if (d.opened) d.sendReport(0x81, data81).catch(() => {})
    }

    const data8F = new Uint8Array(63)
    data8F[1] = channel
    data8F[7] = 0x80
    for (const d of this.devices) {
      if (d.opened) d.sendReport(0x8f, data8F).catch(() => {})
    }
  }
}

// Minimal HID type stubs (WebHID is not yet in all TypeScript lib.dom.d.ts versions)
interface HID {
  requestDevice(options: { filters: { vendorId: number }[] }): Promise<HIDDevice[]>
  getDevices(): Promise<HIDDevice[]>
}

interface HIDDevice {
  opened: boolean
  collections?: { usagePage: number }[]
  open(): Promise<void>
  close(): Promise<void>
  sendReport(reportId: number, data: Uint8Array): Promise<void>
  sendFeatureReport(reportId: number, data: Uint8Array): Promise<void>
  addEventListener(type: 'inputreport', listener: (e: HIDInputReportEvent) => void): void
}

interface HIDInputReportEvent {
  reportId: number
  data: DataView
}
