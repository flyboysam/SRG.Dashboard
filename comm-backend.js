// ═══════════════════════════════════════════════════════════════════
// COMMUNICATION BACKEND
// ═══════════════════════════════════════════════════════════════════
// The one place that knows how to reach the CubeSat. Everything above this
// layer (command handler, parser, terminal UI) talks to CommBackend and
// never touches telemetryState, dataMode, or the radio link directly.
//
// Today there is no uplink: the ground station's RTL-SDR is receive-only,
// so there is no hardware or protocol to transmit a command over. Every
// response below is therefore honest about being either a LOCAL read of
// already-downlinked telemetry, or MOCK synthetic data used to exercise the
// terminal UI when nothing is connected — never a claim that something was
// actually sent to or received from the spacecraft.
//
// When real uplink hardware exists, `sendOperational` (and, if desired,
// `readTelemetry`) are the only functions that need real implementations —
// e.g. opening a WebSocket to the ground-station radio backend described in
// the project's command-flow diagram. Nothing else in the terminal stack
// should need to change.
// ═══════════════════════════════════════════════════════════════════

const CommBackend = (function () {
  const HAS_UPLINK = false; // no TX hardware / CubeSat command protocol wired up yet

  function state() {
    return (typeof getTelemetryState === 'function') ? getTelemetryState() : null;
  }

  // 'local'  — real telemetry, downlinked and cached by the ground station
  // 'mock'   — synthetic data (Test Data mode, or no source at all)
  function linkState() {
    const st = state();
    if (!st) return 'mock';
    if (st.dataMode === 'adafruit' && st.hasData) return 'local';
    return 'mock';
  }

  // One-off illustrative snapshot for when there is truly no telemetry source
  // configured — lets terminal commands still return something to look at.
  // Never written back into telemetryState; the dashboard panels stay honestly
  // zeroed per the disconnected-state design elsewhere in the app.
  function mockSnapshot() {
    const f = (typeof generateTestFrame === 'function') ? generateTestFrame() : {};
    const altCalc = f.press != null ? +(44330 * (1 - Math.pow(f.press / 1013.25, 1 / 5.255))).toFixed(1) : null;
    const batPct = f.battery != null ? Math.min(100, Math.max(0, ((f.battery - 3.5) / (4.5 - 3.5)) * 100)) : null;
    const real = state(); // still pull real session/packet counters — those aren't part of the fiction
    return {
      hasData: true, dataMode: 'mock', source: 'mock',
      temp: f.temp, press: f.press, altCalc, tmp: f.tmp, diodeTemp: f.diodeTemp,
      gx: f.gx, gy: f.gy, gz: f.gz, ax: f.ax, ay: f.ay, az: f.az,
      gm: (f.gx != null) ? Math.sqrt(f.gx ** 2 + f.gy ** 2 + f.gz ** 2) : null,
      am: (f.ax != null) ? Math.sqrt(f.ax ** 2 + f.ay ** 2 + f.az ** 2) : null,
      attRoll: 0, attPitch: 0, attYaw: 0,
      battery: f.battery, batteryCurrent: f.batteryCurrent, batPct,
      batStatus: 'NOMINAL', batRate: 0, batEta: 'STABLE',
      cpuUsage: f.cpuUsage,
      frames: real ? real.frames : 0, pkts: real ? real.pkts : 0,
      sesStart: real ? real.sesStart : Date.now(), lastPacketTime: real ? real.lastPacketTime : null,
    };
  }

  // Read-only telemetry query. Always resolves — there is no "failure" state
  // for a local read, only which tag describes where the numbers came from.
  async function readTelemetry() {
    const link = linkState();
    if (link === 'local') {
      return { tag: 'LOCAL', mockMode: false, data: state() };
    }
    const st = state();
    if (st && st.dataMode === 'test') {
      return { tag: 'MOCK', mockMode: false, data: st }; // synthetic, but user opted into Test Data mode deliberately
    }
    return { tag: 'MOCK', mockMode: true, data: mockSnapshot() };
  }

  // Potentially hardware-affecting command. Confirmation UX lives in the
  // command handler; by the time this is called the operator has already
  // confirmed. This never actually reaches the spacecraft today.
  async function sendOperational(cmdName) {
    return {
      ok: false,
      tag: 'ERROR',
      message: `No uplink transmitter configured — "${cmdName}" was NOT sent to the CubeSat.`,
      note: 'This ground station currently receives telemetry only (RTL-SDR downlink). ' +
            'Command uplink requires TX hardware and an implemented CubeSat command protocol, ' +
            'neither of which exist yet in this build.',
    };
  }

  function isUplinkAvailable() { return HAS_UPLINK; }

  return { linkState, readTelemetry, sendOperational, isUplinkAvailable };
})();
