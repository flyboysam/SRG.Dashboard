#!/usr/bin/env node
/**
 * Build config.js from environment variables (used by GitHub Actions).
 * Expects: AIO_USERNAME, AIO_KEY (from secrets.AIO_Username, secrets.AIO_Key)
 */
const fs = require('fs');
const username = process.env.AIO_USERNAME || '';
const key = process.env.AIO_KEY || '';
const content = `// Generated at build time — values from GitHub Secrets (AIO_Username, AIO_Key)
window.ADAFRUIT_IO_USERNAME = ${JSON.stringify(username)};
window.ADAFRUIT_IO_KEY = ${JSON.stringify(key)};
`;
fs.writeFileSync('config.js', content);
