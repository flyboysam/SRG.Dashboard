// ═══════════════════════════════════════════════════════════════════
// COMMAND PARSER
// ═══════════════════════════════════════════════════════════════════
// Turns a raw terminal input line into { raw, cmd, args }. Deliberately dumb:
// it only tokenizes and normalizes the command name. Whether a command exists,
// whether its arguments are valid, and what it does are all CommandHandler's
// job — the parser doesn't know the command list.
// ═══════════════════════════════════════════════════════════════════

const CommandParser = (function () {
  function parse(rawInput) {
    const raw = (rawInput || '').trim();
    if (!raw) return null;
    const parts = raw.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    return { raw, cmd, args };
  }
  return { parse };
})();
