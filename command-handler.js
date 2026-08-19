// ═══════════════════════════════════════════════════════════════════
// COMMAND HANDLER
// ═══════════════════════════════════════════════════════════════════
// Decides what a validated command actually does, and formats a response.
// Talks to CommBackend for data/actions — never reads telemetryState or the
// DOM directly. Talks to nothing UI-related; it has no idea a terminal exists.
//
// A "response" is always { lines } or { clearScreen:true }. Each entry in
// `lines` is either a plain string (rendered as normal terminal text) or a
// [text, cssClass] pair (rendered with a specific style — used for the
// [LOCAL]/[MOCK]/[ERROR] provenance tags and section headers).
// ═══════════════════════════════════════════════════════════════════

const CommandHandler = (function () {

  // ── Sensor registry — the single source of truth for `sensor <name>` and `sensors` ──
  const SENSOR_REGISTRY = {
    battery_voltage:  { label: 'Battery Voltage',        unit: 'V',   dp: 2, get: d => d.battery },
    voltage:          { label: 'Battery Voltage',        unit: 'V',   dp: 2, get: d => d.battery, alias: 'battery_voltage' },
    battery_current:  { label: 'Battery Current',        unit: 'A',   dp: 2, get: d => d.batteryCurrent },
    current:          { label: 'Battery Current',        unit: 'A',   dp: 2, get: d => d.batteryCurrent, alias: 'battery_current' },
    battery_percent:  { label: 'Battery State of Charge', unit: '%',  dp: 0, get: d => d.batPct },
    temperature:      { label: 'MS5611 Temperature',     unit: '°C',  dp: 2, get: d => d.temp },
    ihu_temperature:  { label: 'Pi IHU Temperature',     unit: '°C',  dp: 1, get: d => d.tmp },
    diode_temperature:{ label: 'Diode D3 Temperature',   unit: '°C',  dp: 1, get: d => d.diodeTemp },
    pressure:         { label: 'Barometric Pressure',    unit: 'hPa', dp: 2, get: d => d.press },
    altitude:         { label: 'Barometric Altitude',    unit: 'm',   dp: 1, get: d => d.altCalc },
    roll:             { label: 'Roll',                   unit: '°',   dp: 1, get: d => d.attRoll },
    pitch:            { label: 'Pitch',                  unit: '°',   dp: 1, get: d => d.attPitch },
    yaw:              { label: 'Yaw',                    unit: '°',   dp: 1, get: d => d.attYaw },
    gyro_x:           { label: 'Gyro X',                 unit: '°/s', dp: 2, get: d => d.gx },
    gyro_y:           { label: 'Gyro Y',                 unit: '°/s', dp: 2, get: d => d.gy },
    gyro_z:           { label: 'Gyro Z',                 unit: '°/s', dp: 2, get: d => d.gz },
    accel_x:          { label: 'Accel X',                unit: 'g',   dp: 2, get: d => d.ax },
    accel_y:          { label: 'Accel Y',                unit: 'g',   dp: 2, get: d => d.ay },
    accel_z:          { label: 'Accel Z',                unit: 'g',   dp: 2, get: d => d.az },
    cpu_usage:        { label: 'CPU Usage',               unit: '%',  dp: 1, get: d => d.cpuUsage },
    gps:              { label: 'GPS / Position', unit: '', dp: 0, get: () => null,
      unavailable: 'No GPS feed on this CubeSat build. Position is inferred from barometric altitude only — see "sensor altitude".' },
  };

  function canonicalSensor(name) {
    const entry = SENSOR_REGISTRY[name];
    if (!entry) return null;
    return entry.alias ? { key: entry.alias, ...SENSOR_REGISTRY[entry.alias] } : { key: name, ...entry };
  }

  // ── Command classification ──
  const OPERATIONAL = {
    reboot:   'reboot the CubeSat',
    reset:    'reset the CubeSat flight computer',
    shutdown: 'shut down the CubeSat',
    transmit: 'transmit an uplink message to the CubeSat',
  };
  function isOperational(cmd) { return Object.prototype.hasOwnProperty.call(OPERATIONAL, cmd); }
  function describeOperational(cmd) { return OPERATIONAL[cmd] || 'perform this action'; }

  // ── Formatting helpers ──
  const fmt = (v, dp, unit) => v == null || isNaN(v) ? 'N/A' : `${(+v).toFixed(dp)}${unit ? ' ' + unit : ''}`;
  const tag = t => [`[${t}]`, 'ttag-' + t.toLowerCase()];
  const rule = () => '────────────────────────────────';
  function provenanceTag(res) { return res.mockMode ? tag('MOCK') : tag(res.tag); }
  function mockBanner(res) {
    if (!res.mockMode) return [];
    return [
      'CubeSat connection: DISCONNECTED',
      '',
      'Displaying simulated telemetry so the terminal can be exercised offline.',
      '',
    ];
  }
  function fmtUptime(sesStart) {
    if (!sesStart) return '00:00:00';
    const e = Date.now() - sesStart;
    const h = String(Math.floor(e / 3600000)).padStart(2, '0');
    const m = String(Math.floor((e % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((e % 60000) / 1000)).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  // ── Commands ──
  const COMMANDS = {

    async help() {
      return { lines: [
        'Available CubeSat Commands',
        rule(),
        '',
        'SYSTEM',
        '  status              System status',
        '  health              System health',
        '  uptime              CubeSat uptime',
        '  ping                Test communications',
        '',
        'TELEMETRY',
        '  telemetry           Show current telemetry',
        '  sensors             List available sensors',
        '  sensor <name>       Read a specific sensor',
        '  battery             Battery telemetry',
        '  temperature         Temperature telemetry',
        '  position            GPS/position data',
        '  power               Power-system telemetry',
        '',
        'RADIO',
        '  radio               Radio status',
        '  packets             Packet statistics',
        '',
        'OPERATIONAL  (require confirmation — not yet transmittable, see "radio")',
        '  reboot, reset, shutdown, transmit',
        '',
        'TERMINAL',
        '  clear, cls          Clear terminal',
        '  help                Show this help menu',
        '',
        rule(),
      ] };
    },

    async status() {
      const res = await CommBackend.readTelemetry();
      const d = res.data;
      return { lines: [
        provenanceTag(res),
        ...mockBanner(res),
        'CubeSat System Status',
        `Power:          ${d.hasData ? 'NOMINAL' : 'NO DATA'}`,
        `Battery:        ${fmt(d.battery, 2, 'V')}`,
        `Temperature:    ${fmt(d.temp, 2, '°C')}`,
        `Communications: ${res.tag === 'LOCAL' ? 'NOMINAL' : 'DISCONNECTED'}`,
      ] };
    },

    async health() {
      const res = await CommBackend.readTelemetry();
      const d = res.data;
      const line = (label, ok) => `${label.padEnd(16)}${d.hasData ? (ok ? 'NOMINAL' : 'CAUTION') : 'NO DATA'}`;
      const battOk = d.battery != null && d.battery >= 3.5 && d.battery <= 4.5;
      const thermOk = d.temp != null && d.temp > 10 && d.temp < 40;
      return { lines: [
        provenanceTag(res),
        ...mockBanner(res),
        'CubeSat Health Summary',
        line('Power/Battery:', battOk),
        line('Thermal:', thermOk),
        line('Attitude Sensors:', d.gx != null),
        line('Communications:', res.tag === 'LOCAL'),
        '',
        `Overall: ${d.hasData ? ((battOk && thermOk) ? 'NOMINAL' : 'CAUTION') : 'UNKNOWN — NO TELEMETRY'}`,
      ] };
    },

    async uptime() {
      const res = await CommBackend.readTelemetry();
      return { lines: [
        provenanceTag(res),
        `Mission elapsed time: ${fmtUptime(res.data.sesStart)}`,
      ] };
    },

    async ping() {
      const res = await CommBackend.readTelemetry();
      if (res.tag === 'LOCAL') {
        return { lines: [tag('LOCAL'), 'PONG — downlink active, telemetry current.'] };
      }
      return { lines: [tag('MOCK'), 'PONG (simulated) — no live CubeSat link established.'] };
    },

    async telemetry() {
      const res = await CommBackend.readTelemetry();
      const d = res.data;
      return { lines: [
        provenanceTag(res),
        ...mockBanner(res),
        'Current Telemetry Snapshot',
        rule(),
        `MS5611 Temp     ${fmt(d.temp, 2, '°C')}`,
        `Pressure        ${fmt(d.press, 2, 'hPa')}`,
        `Altitude (baro) ${fmt(d.altCalc, 1, 'm')}`,
        `Pi IHU Temp     ${fmt(d.tmp, 1, '°C')}`,
        `Diode D3 Temp   ${fmt(d.diodeTemp, 1, '°C')}`,
        `Gyro (x,y,z)    ${fmt(d.gx, 2, '')}, ${fmt(d.gy, 2, '')}, ${fmt(d.gz, 2, '')} °/s`,
        `Accel (x,y,z)   ${fmt(d.ax, 2, '')}, ${fmt(d.ay, 2, '')}, ${fmt(d.az, 2, '')} g`,
        `Battery         ${fmt(d.battery, 2, 'V')}  (${d.batStatus || 'NO DATA'})`,
        `Frames / Pkts   ${d.frames || 0} / ${d.pkts || 0}`,
        rule(),
      ] };
    },

    async sensors() {
      const res = await CommBackend.readTelemetry();
      const d = res.data;
      const seen = new Set();
      const lines = [provenanceTag(res), 'Available Sensors', rule()];
      for (const key of Object.keys(SENSOR_REGISTRY)) {
        const entry = SENSOR_REGISTRY[key];
        if (entry.alias) continue; // list canonical names only
        if (seen.has(key)) continue;
        seen.add(key);
        const val = entry.get(d);
        const shown = entry.unavailable ? 'N/A' : fmt(val, entry.dp, entry.unit);
        lines.push(`  ${key.padEnd(20)}${shown}`);
      }
      lines.push(rule(), 'Usage: sensor <name>');
      return { lines };
    },

    async sensor(args) {
      const nameRaw = (args[0] || '').toLowerCase();
      if (!nameRaw) {
        return { lines: [tag('ERROR'), 'Usage: sensor <name>', '', 'Type "sensors" to view available sensors.'] };
      }
      const entry = canonicalSensor(nameRaw);
      if (!entry) {
        return { lines: [tag('ERROR'), `Unknown sensor: ${nameRaw}`, '', 'Type "sensors" to view available sensors.'] };
      }
      const res = await CommBackend.readTelemetry();
      const val = entry.get(res.data);
      const t = provenanceTag(res);
      if (entry.unavailable) {
        return { lines: [t, `${entry.label}: N/A`, entry.unavailable] };
      }
      if (val == null) {
        return { lines: [t, `${entry.label}: N/A`, 'No data available for this sensor right now.'] };
      }
      return { lines: [t, `${entry.label}: ${fmt(val, entry.dp, entry.unit)}`] };
    },

    async battery() {
      const res = await CommBackend.readTelemetry();
      const d = res.data;
      return { lines: [
        provenanceTag(res),
        ...mockBanner(res),
        `Battery Voltage: ${fmt(d.battery, 2, 'V')}`,
        `Battery Current: ${fmt(d.batteryCurrent, 2, 'A')}`,
        `Battery State:   ${d.batPct != null ? Math.round(d.batPct) + '%' : 'N/A'}`,
        `Battery Status:  ${d.batStatus || 'NO DATA'}`,
      ] };
    },

    async temperature() {
      const res = await CommBackend.readTelemetry();
      const d = res.data;
      const ok = d.temp != null && d.temp > 10 && d.temp < 40;
      return { lines: [
        provenanceTag(res),
        ...mockBanner(res),
        `TEMP-01 (MS5611):    ${fmt(d.temp, 2, '°C')}`,
        `TEMP-02 (Pi IHU):    ${fmt(d.tmp, 1, '°C')}`,
        `TEMP-03 (Diode D3):  ${fmt(d.diodeTemp, 1, '°C')}`,
        '',
        `Status: ${d.hasData ? (ok ? 'NOMINAL' : 'OUT OF RANGE') : 'NO DATA'}`,
      ] };
    },

    async position() {
      const res = await CommBackend.readTelemetry();
      const d = res.data;
      return { lines: [
        provenanceTag(res),
        ...mockBanner(res),
        'Position',
        `Altitude (baro): ${fmt(d.altCalc, 1, 'm')}`,
        'GPS Fix:         NOT AVAILABLE',
        '',
        'This CubeSat build has no GPS feed — altitude is derived from barometric pressure only.',
      ] };
    },

    async power() {
      const res = await CommBackend.readTelemetry();
      const d = res.data;
      return { lines: [
        provenanceTag(res),
        ...mockBanner(res),
        'Power System',
        `Battery Voltage: ${fmt(d.battery, 2, 'V')}`,
        `Battery Current: ${fmt(d.batteryCurrent, 2, 'A')}`,
        `State of Charge: ${d.batPct != null ? Math.round(d.batPct) + '%' : 'N/A'}`,
        `Status:          ${d.batStatus || 'NO DATA'}`,
        '',
        'Solar Panels:    NOT TELEMETERED (no panel-voltage feed configured)',
      ] };
    },

    async radio() {
      const link = CommBackend.linkState();
      return { lines: [
        tag(link === 'local' ? 'LOCAL' : 'MOCK'),
        'Radio Status',
        `Uplink:    435.000 MHz — NO TX HARDWARE (receive-only ground station)`,
        `Downlink:  434.900 MHz`,
        `Protocol:  APRS / AFSK 1200Bd`,
        `Link:      ${link === 'local' ? 'NOMINAL' : 'DISCONNECTED'}`,
      ] };
    },

    async packets() {
      const res = await CommBackend.readTelemetry();
      const d = res.data;
      const last = d.lastPacketTime ? new Date(d.lastPacketTime).toISOString() : '—';
      return { lines: [
        provenanceTag(res),
        'Packet Statistics',
        `Frames RX:    ${d.frames || 0}`,
        `Packets:      ${d.pkts || 0}`,
        `Last Packet:  ${last}`,
      ] };
    },

    async clear() { return { clearScreen: true }; },
    async cls() { return { clearScreen: true }; },

    // Operational commands: by the time these run, the terminal has already
    // gotten an explicit "CONFIRM <CMD>" from the operator.
    async reboot() { return operationalResult('reboot'); },
    async reset() { return operationalResult('reset'); },
    async shutdown() { return operationalResult('shutdown'); },
    async transmit(args) { return operationalResult('transmit', args); },
  };

  async function operationalResult(cmd) {
    const res = await CommBackend.sendOperational(cmd);
    return { lines: [tag(res.tag), res.message, '', res.note] };
  }

  function get(cmd) { return COMMANDS[cmd]; }
  function listCommands() { return Object.keys(COMMANDS); }
  function listSensors() {
    return Object.keys(SENSOR_REGISTRY).filter(k => !SENSOR_REGISTRY[k].alias);
  }

  return { get, listCommands, listSensors, isOperational, describeOperational };
})();
