<template>
  <div class="app">
    <header>
      <h1>Steam Controller Auto-Dock</h1>
      <div class="status-row">
        <span :class="['dot', connected ? 'green' : 'red']" />
        <span>{{ connected ? 'Controller connected' : 'Not connected' }}</span>
        <span v-if="connected" class="battery">
          Battery: {{ ctrl.batteryPercent }}%
          <span v-if="ctrl.isCharging === true" class="charging"> ⚡ Charging</span>
          <span v-if="ctrl.batteryPercent >= 100" class="full"> ✓ Full</span>
        </span>
      </div>
    </header>

    <main>
      <!-- Connection & Control buttons -->
      <section class="panel controls">
        <button v-if="!connected" @click="doConnect" class="btn-primary">
          Connect Controller (WebHID)
        </button>
        <template v-else>
          <button
            v-if="nav.state === 'IDLE' || nav.state === 'FAILED'"
            @click="startNav"
            class="btn-primary"
          >
            Start Auto-Dock
          </button>
          <button v-else @click="stopNav" class="btn-danger">Stop</button>
          <button @click="doEStop" class="btn-estop">E-STOP</button>
          <button
            @click="calibrate"
            class="btn-secondary"
            title="Sets arrival RSSI threshold to current value − 10"
          >
            Calibrate (now: {{ ctrl.signalStrength }})
          </button>
        </template>
      </section>

      <!-- Navigation State -->
      <section class="panel state-panel">
        <div class="state-label" :class="'state-' + nav.state">{{ STATE_LABELS[nav.state] }}</div>
        <div class="state-desc">{{ STATE_DESCS[nav.state] }}</div>
        <div v-if="nav.state === 'SHIMMY'" class="shimmy-progress">
          Shimmy phase {{ nav['shimmyPhase'] + 1 }} / 8
        </div>
      </section>

      <!-- Gauges row -->
      <section class="panel gauges">
        <!-- RSSI Signal Strength -->
        <div class="gauge-box">
          <div class="gauge-title">Signal Strength to Puck (RSSI)</div>
          <div class="rssi-track">
            <div class="rssi-fill" :style="{ width: rssiPercent + '%', background: rssiColor }" />
            <div
              class="rssi-threshold-marker"
              :style="{ left: thresholdPercent + '%' }"
              title="Arrival threshold"
            />
          </div>
          <div class="rssi-labels">
            <span class="rssi-value">
              {{ rssiSmoothed }}
              <span class="rssi-trend" :class="{
                'trend-up':   rssiTrend === '↑',
                'trend-down': rssiTrend === '↓',
              }">{{ rssiTrend }}</span>
            </span>
            <span class="rssi-limit">/ 255 &nbsp; target ≥ {{ nav.arrivalRssiThreshold }}</span>
          </div>
          <div class="rssi-sub">raw: {{ ctrl.signalStrength }} &nbsp;|&nbsp; avg {{ rssiSmoothed }} ({{ rssiBuffer.length }} samples)</div>
        </div>

        <!-- Compass (gyro heading) -->
        <div class="gauge-box">
          <div class="gauge-title">Compass (Gyro Heading)</div>
          <canvas ref="compassRef" width="140" height="140" />
          <div class="compass-label">
            {{ headingDeg.toFixed(1) }}° &nbsp;|&nbsp; target: {{ targetDeg.toFixed(1) }}°
          </div>
        </div>

        <!-- Polar RSSI scan plot -->
        <div class="gauge-box">
          <div class="gauge-title">RSSI Scan (Polar Plot)</div>
          <canvas ref="polarRef" width="180" height="180" />
        </div>
      </section>

      <!-- Manual override d-pad -->
      <section class="panel manual">
        <div class="gauge-title" style="margin-bottom:0.5rem">Manual Control</div>
        <div class="dpad">
          <button
            @mousedown="manualCmd('FORWARD')"
            @mouseup="manualCmd('STOP')"
            @mouseleave="manualCmd('STOP')"
            @touchstart.prevent="manualCmd('FORWARD')"
            @touchend.prevent="manualCmd('STOP')"
            class="dpad-btn"
          >▲</button>
          <div class="dpad-row">
            <button
              @mousedown="manualCmd('LEFT')"
              @mouseup="manualCmd('STOP')"
              @mouseleave="manualCmd('STOP')"
              @touchstart.prevent="manualCmd('LEFT')"
              @touchend.prevent="manualCmd('STOP')"
              class="dpad-btn"
            >◀</button>
            <button @click="manualCmd('STOP')" class="dpad-btn stop-btn">■</button>
            <button
              @mousedown="manualCmd('RIGHT')"
              @mouseup="manualCmd('STOP')"
              @mouseleave="manualCmd('STOP')"
              @touchstart.prevent="manualCmd('RIGHT')"
              @touchend.prevent="manualCmd('STOP')"
              class="dpad-btn"
            >▶</button>
          </div>
        </div>
      </section>

      <!-- Debug panel -->
      <details class="panel debug">
        <summary>Debug / IMU Raw Data</summary>
        <pre>{{ debugText }}</pre>
        <div class="imu-note">
          Note: gyroZ is used for heading integration. If the controller rotates but heading
          doesn't change, adjust IMU_BASE or the gyro axis index in steamController.ts.
        </div>
      </details>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, shallowReactive, onMounted, onUnmounted } from 'vue'
import { SteamController } from './steamController'
import { Navigator } from './navigator'
import type { NavState } from './navigator'

// ── Reactive state ──────────────────────────────────────────────────────

const ctrl = shallowReactive(new SteamController())
const nav  = shallowReactive(new Navigator(ctrl))

const connected  = ref(false)
const tick       = ref(0)
const compassRef = ref<HTMLCanvasElement | null>(null)
const polarRef   = ref<HTMLCanvasElement | null>(null)

// Rolling buffer for smoothed RSSI — only stores distinct readings
const RSSI_BUF = 30
const rssiBuffer: number[] = []
let _rssiPrev = -1

// ── Labels ─────────────────────────────────────────────────────────────

const STATE_LABELS: Record<NavState, string> = {
  IDLE:     'Ready',
  SCANNING: 'Scanning directions...',
  ALIGNING: 'Aligning...',
  MOVING:   'Moving to station...',
  ARRIVED:  'Arrived',
  SHIMMY:   'Shimmy alignment...',
  FAILED:   'Docking failed',
}

const STATE_DESCS: Record<NavState, string> = {
  IDLE:     'Press "Start Auto-Dock" to begin.',
  SCANNING: 'Rotating 360° and sampling RSSI signal in all directions.',
  ALIGNING: 'Turning toward the direction with the strongest signal.',
  MOVING:   'Driving toward the strongest signal. Re-scanning on signal drop.',
  ARRIVED:  'RSSI threshold reached — waiting for charge confirmation...',
  SHIMMY:   'Fine-alignment: alternating left/right movement to physically dock.',
  FAILED:   'All shimmy phases exhausted without charging. Please position manually.',
}

// ── Computed ────────────────────────────────────────────────────────────

const rssiSmoothed = computed(() => {
  void tick.value
  if (!rssiBuffer.length) return ctrl.signalStrength
  return Math.round(rssiBuffer.reduce((a, b) => a + b, 0) / rssiBuffer.length)
})

const rssiTrend = computed((): '↑' | '↓' | '→' | '–' => {
  void tick.value
  if (rssiBuffer.length < 6) return '–'
  const h = Math.floor(rssiBuffer.length / 2)
  const older = rssiBuffer.slice(0, h).reduce((a, b) => a + b, 0) / h
  const newer = rssiBuffer.slice(-h).reduce((a, b) => a + b, 0) / h
  const d = newer - older
  if (d >  2) return '↑'
  if (d < -2) return '↓'
  return '→'
})

const rssiPercent      = computed(() => { void tick.value; return (rssiSmoothed.value / 255) * 100 })
const thresholdPercent = computed(() => { void tick.value; return (nav.arrivalRssiThreshold / 255) * 100 })
const headingDeg       = computed(() => { void tick.value; return ((nav.heading * 180) / Math.PI) % 360 })
const targetDeg        = computed(() => { void tick.value; return ((nav.targetHeading * 180) / Math.PI) % 360 })

const rssiColor = computed(() => {
  void tick.value
  const r = rssiSmoothed.value / 255
  const g = Math.round(80 + r * 175)
  const b = Math.round(180 + r * 50)
  return `rgb(0, ${g}, ${b})`
})

const debugText = computed(() => {
  void tick.value   // reactive dependency → re-runs on every render tick
  const imu = ctrl.imuData
  const raw = ctrl.lastRawReport
  const hex = (b: number) => b.toString(16).padStart(2, '0')
  const rawHex = raw.length > 0
    ? Array.from(raw.slice(0, 32)).map(hex).join(' ')
    : '—'
  return `State:       ${nav.state}
Command:     ${nav.lastCommand}
Heading:     ${headingDeg.value.toFixed(2)}°
Target:      ${targetDeg.value.toFixed(2)}°
RSSI:        ${ctrl.signalStrength}  (threshold: ${nav.arrivalRssiThreshold})
Battery:     ${ctrl.batteryPercent}%  (${ctrl.batteryVoltage} mV)
Charging:    ${ctrl.isCharging}
GyroXYZ:     ${imu.gyroX}, ${imu.gyroY}, ${imu.gyroZ}
AccelXYZ:    ${imu.accelX}, ${imu.accelY}, ${imu.accelZ}
IMU-Ts:      ${imu.timestamp ? new Date(imu.timestamp).toISOString().slice(11, 23) : '—'}
ScanPoints:  ${nav.scanPoints.length}
ReportId:    0x${ctrl.lastReportId.toString(16).toUpperCase()}  len=${ctrl.lastReportLength}
Raw[0..31]:  ${rawHex}`
})

// ── Actions ─────────────────────────────────────────────────────────────

async function doConnect() {
  const ok = await ctrl.connect()
  if (ok) { rssiBuffer.length = 0; _rssiPrev = -1 }
  connected.value = ok
}

function startNav() {
  nav.start()
}

function stopNav() {
  nav.stop()
}

function doEStop() {
  ctrl.eStop = true
  nav.stop()
  setTimeout(() => { ctrl.eStop = false }, 300)
}

function calibrate() {
  nav.calibrateArrivalRSSI()
}

async function manualCmd(cmd: string) {
  if (!connected.value) return
  if (cmd === 'STOP') {
    await ctrl.stopAll()
  } else if (cmd === 'FORWARD') {
    await ctrl.pulse(0, 70); await ctrl.pulse(1, 70)
  } else if (cmd === 'LEFT') {
    await ctrl.pulse(0, 70); await ctrl.stop(1)
  } else if (cmd === 'RIGHT') {
    await ctrl.stop(0); await ctrl.pulse(1, 70)
  }
}

// ── Canvas rendering ────────────────────────────────────────────────────

function drawCompass() {
  const canvas = compassRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')!
  const cx = 70, cy = 70, r = 58
  ctx.clearRect(0, 0, 140, 140)

  // Background
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = '#0d1117'
  ctx.fill()
  ctx.strokeStyle = '#30363d'
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Grid rings
  for (const frac of [0.33, 0.66]) {
    ctx.beginPath()
    ctx.arc(cx, cy, r * frac, 0, Math.PI * 2)
    ctx.strokeStyle = '#1c2128'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  // Cardinal labels
  ctx.fillStyle = '#484f58'
  ctx.font = '11px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('N', cx, cy - r + 10)
  ctx.fillText('S', cx, cy + r - 10)
  ctx.fillText('W', cx - r + 8, cy)
  ctx.fillText('E', cx + r - 8, cy)

  // Target heading (orange dashed)
  if (nav.state !== 'IDLE' && nav.state !== 'SCANNING') {
    const th = nav.targetHeading
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.sin(th) * (r - 4), cy - Math.cos(th) * (r - 4))
    ctx.strokeStyle = '#f0883e'
    ctx.lineWidth = 2
    ctx.setLineDash([4, 4])
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Current heading (blue solid)
  const h = nav.heading
  const nx = cx + Math.sin(h) * (r - 4)
  const ny = cy - Math.cos(h) * (r - 4)
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(nx, ny)
  ctx.strokeStyle = '#58a6ff'
  ctx.lineWidth = 3
  ctx.stroke()

  // Center dot
  ctx.beginPath()
  ctx.arc(cx, cy, 4, 0, Math.PI * 2)
  ctx.fillStyle = '#fff'
  ctx.fill()
}

function drawPolar() {
  const canvas = polarRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')!
  const cx = 90, cy = 90, maxR = 78
  ctx.clearRect(0, 0, 180, 180)

  // Background
  ctx.beginPath()
  ctx.arc(cx, cy, maxR, 0, Math.PI * 2)
  ctx.fillStyle = '#0d1117'
  ctx.fill()
  ctx.strokeStyle = '#30363d'
  ctx.lineWidth = 1
  ctx.stroke()

  // Grid rings with RSSI labels
  for (const frac of [0.25, 0.5, 0.75, 1.0]) {
    ctx.beginPath()
    ctx.arc(cx, cy, maxR * frac, 0, Math.PI * 2)
    ctx.strokeStyle = '#1c2128'
    ctx.stroke()
  }

  const pts = nav.scanPoints
  if (pts.length < 2) {
    ctx.fillStyle = '#484f58'
    ctx.font = '11px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Scan running...', cx, cy)
    return
  }

  const maxRSSI = Math.max(...pts.map(p => p.rssi), 1)

  // Filled area
  ctx.beginPath()
  pts.forEach((p, i) => {
    const rr = (p.rssi / maxRSSI) * maxR
    const x = cx + Math.sin(p.heading) * rr
    const y = cy - Math.cos(p.heading) * rr
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.closePath()
  ctx.fillStyle = 'rgba(88, 166, 255, 0.08)'
  ctx.fill()

  // Scan path line
  ctx.beginPath()
  pts.forEach((p, i) => {
    const rr = (p.rssi / maxRSSI) * maxR
    const x = cx + Math.sin(p.heading) * rr
    const y = cy - Math.cos(p.heading) * rr
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.strokeStyle = '#58a6ff'
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Best RSSI point (orange dot)
  const best = pts.reduce((a, b) => (a.rssi >= b.rssi ? a : b))
  const br = (best.rssi / maxRSSI) * maxR
  const bx = cx + Math.sin(best.heading) * br
  const by = cy - Math.cos(best.heading) * br
  ctx.beginPath()
  ctx.arc(bx, by, 5, 0, Math.PI * 2)
  ctx.fillStyle = '#f0883e'
  ctx.fill()

  // Max RSSI label
  ctx.fillStyle = '#58a6ff'
  ctx.font = '10px monospace'
  ctx.textAlign = 'center'
  ctx.fillText(`max ${best.rssi}`, cx, 12)
}

// ── Lifecycle ───────────────────────────────────────────────────────────

let rafId: number | null = null

function render() {
  const rssi = ctrl.signalStrength
  if (rssi !== _rssiPrev && connected.value) {
    _rssiPrev = rssi
    rssiBuffer.push(rssi)
    if (rssiBuffer.length > RSSI_BUF) rssiBuffer.shift()
  }
  tick.value++
  drawCompass()
  drawPolar()
  rafId = requestAnimationFrame(render)
}

onMounted(() => {
  rafId = requestAnimationFrame(render)
})

onUnmounted(() => {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
  nav.stop()
  ctrl.disconnect()
})
</script>
