// ═══════════════════════════════════════════════════════════════════
// TERMINAL UI
// ═══════════════════════════════════════════════════════════════════
// Owns the input box, keyboard handling, command history, autocomplete, and
// rendering command echoes/responses into the shared #tlog pane (via tprint/
// tlog/clearTerminal from app.js). It knows nothing about telemetry, sensors,
// or the comm link — every command gets handed to CommandParser, and every
// result comes back from CommandHandler already formatted.
// ═══════════════════════════════════════════════════════════════════

(function () {
  const PROMPT = 'CUBESAT-GS >';

  let history = [];
  let histIndex = -1;   // -1 = viewing the live draft, 0 = most recent history entry, etc.
  let draft = '';
  let pending = null;   // { cmd, args, expires } — an operational command awaiting "CONFIRM <CMD>"

  let inputEl, panelEl;

  function init() {
    inputEl = document.getElementById('term-input');
    panelEl = document.getElementById('term-body');
    if (!inputEl) return; // terminal markup not present — nothing to wire up

    inputEl.addEventListener('keydown', onKeyDown);

    // Click anywhere in the terminal body to focus the input, like a real console —
    // but don't steal focus away from a text selection (copying log output).
    if (panelEl) {
      panelEl.addEventListener('mousedown', () => { panelEl.dataset.hadSelection = String(!!window.getSelection().toString()); });
      panelEl.addEventListener('click', () => {
        if (panelEl.dataset.hadSelection === 'true') return;
        inputEl.focus();
      });
    }
  }

  function onKeyDown(e) {
    switch (e.key) {
      case 'Enter': {
        e.preventDefault();
        const val = inputEl.value;
        inputEl.value = '';
        handleSubmit(val);
        break;
      }
      case 'ArrowUp':
        e.preventDefault();
        historyNav(1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        historyNav(-1);
        break;
      case 'Tab':
        e.preventDefault();
        autocomplete();
        break;
      case 'Escape':
        if (pending) {
          tlog('Confirmation cancelled.', 'twn');
          pending = null;
          updatePendingUI();
        }
        break;
    }
  }

  function historyNav(dir) {
    if (history.length === 0) return;
    if (dir > 0) { // up — older
      if (histIndex === -1) draft = inputEl.value;
      if (histIndex < history.length - 1) histIndex++;
    } else { // down — newer
      if (histIndex <= 0) { histIndex = -1; inputEl.value = draft; return; }
      histIndex--;
    }
    inputEl.value = history[history.length - 1 - histIndex];
    const len = inputEl.value.length;
    inputEl.setSelectionRange(len, len);
  }

  function pushHistory(cmd) {
    if (history[history.length - 1] !== cmd) history.push(cmd);
    histIndex = -1;
    draft = '';
  }

  function autocomplete() {
    const val = inputEl.value;
    const parts = val.split(/\s+/);
    if (parts.length <= 1) {
      const partial = (parts[0] || '').toLowerCase();
      if (!partial) return;
      applyCompletion(CommandHandler.listCommands().filter(c => c.startsWith(partial)), partial, val, 0);
    } else if (parts[0].toLowerCase() === 'sensor') {
      const partial = (parts[1] || '').toLowerCase();
      const start = val.indexOf(parts[1] || '', parts[0].length);
      applyCompletion(CommandHandler.listSensors().filter(s => s.startsWith(partial)), partial, val, start);
    }
  }

  function applyCompletion(matches, partial, fullVal, replaceStart) {
    if (matches.length === 1) {
      inputEl.value = fullVal.slice(0, replaceStart) + matches[0] + ' ';
      const len = inputEl.value.length;
      inputEl.setSelectionRange(len, len);
    } else if (matches.length > 1) {
      tprint(`${PROMPT} ${fullVal}`, 'tcmd');
      tprint(matches.join('   '), 'tsys');
    }
  }

  // A quick acknowledgement ring around the input bar the instant a command is
  // actually submitted — restarts even if the previous flash hasn't finished.
  function flashSubmitRow() {
    const row = inputEl && inputEl.closest('.term-inputrow');
    if (!row) return;
    row.classList.remove('submit-flash');
    void row.offsetWidth; // force reflow so the animation restarts even if it's already mid-play
    row.classList.add('submit-flash');
  }

  async function handleSubmit(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    flashSubmitRow();

    // A confirmation is pending — check if this line confirms it.
    if (pending) {
      if (trimmed.toUpperCase() === `CONFIRM ${pending.cmd.toUpperCase()}`) {
        tprint(`${PROMPT} ${raw}`, 'tcmd');
        pushHistory(trimmed);
        const fn = CommandHandler.get(pending.cmd);
        pending = null;
        updatePendingUI();
        const res = fn ? await fn([]) : null;
        render(res);
        return;
      }
      tlog('Confirmation cancelled — pending command dropped.', 'twn');
      pending = null;
      updatePendingUI();
      // fall through and process the newly typed line normally
    }

    tprint(`${PROMPT} ${raw}`, 'tcmd');
    pushHistory(trimmed);

    const parsed = CommandParser.parse(trimmed);
    if (!parsed) return;

    const fn = CommandHandler.get(parsed.cmd);
    if (!fn) {
      tprint('[ERROR] Unknown command: ' + parsed.cmd, 'ttag-error');
      tprint('Type "help" for a list of available commands.', 'tsys');
      return;
    }

    if (CommandHandler.isOperational(parsed.cmd)) {
      pending = { cmd: parsed.cmd, args: parsed.args, expires: Date.now() + 20000 };
      updatePendingUI();
      tprint(`WARNING: This command will ${CommandHandler.describeOperational(parsed.cmd)}.`, 'twn');
      tprint(`Type "CONFIRM ${parsed.cmd.toUpperCase()}" to continue, or Esc to cancel.`, 'tsys');
      return;
    }

    const res = await fn(parsed.args);
    render(res);
  }

  function render(res) {
    if (!res) return;
    if (res.clearScreen) { clearTerminal(); return; }
    (res.lines || []).forEach(line => {
      if (Array.isArray(line)) tprint(line[0], line[1]);
      else tprint(line === '' ? '&nbsp;' : line, 'tresp');
    });
  }

  function updatePendingUI() {
    if (!inputEl) return;
    inputEl.classList.toggle('pending', !!pending);
    inputEl.placeholder = pending ? `type "CONFIRM ${pending.cmd.toUpperCase()}" or Esc to cancel` : 'type "help" to begin';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
