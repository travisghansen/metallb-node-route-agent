/**
 * Levels
 *
 * error: 0
 * warn: 1
 * info: 2
 * verbose: 3
 * debug: 4
 * silly: 5
 */

const winston = require('winston');
const os = require('os');

const env = process.env.NODE_ENV || 'development';
let level = process.env.LOG_LEVEL || null;
const hostname = os.hostname();

if (!level) {
  if (env == 'production') {
    level = 'info';
  } else {
    level = 'verbose';
  }
}

let formatters;
let defaultMeta;
if (env == 'production') {
  formatters = [winston.format.json()];
  defaultMeta = { service: 'metallb-node-route-agent', hostname };
} else {
  formatters = [winston.format.colorize(), winston.format.simple()];
  defaultMeta = {};
}

const logger = winston.createLogger({
  level: level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    ...formatters
  ),
  defaultMeta: defaultMeta,
  transports: [
    new winston.transports.Console({
      handleExceptions: true
    })
  ]
});

module.exports.logger = logger;
