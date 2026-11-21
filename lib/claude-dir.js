'use strict';

const os = require('node:os');
const path = require('node:path');

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');

const expandHome = (p) => (typeof p === 'string' ? p : '').replace(/^~/, os.homedir());

function resolveClaudeDir(flag, env = process.env) {
  const raw = flag || env.CLAUDE_CONFIG_DIR || env.CLAUDE_DIR;
  return raw ? expandHome(raw) : DEFAULT_CLAUDE_DIR;
}

module.exports = { DEFAULT_CLAUDE_DIR, expandHome, resolveClaudeDir };
