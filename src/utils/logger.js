'use strict'

const { createLogger, format, transports } = require('winston')
const DailyRotateFile = require('winston-daily-rotate-file')
const path = require('path')
const config = require('../config')

const { combine, timestamp, printf, colorize, errors, json } = format

// ─── Custom Log Format ───────────────────────────────────────

const devFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : ''
  return `[${timestamp}] ${level}: ${stack || message}${metaStr}`
})

// ─── Transports ──────────────────────────────────────────────

const fileTransportOptions = (filename, level = 'info') => ({
  filename: path.join(config.logging.dir, `${filename}-%DATE%.log`),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d',
  level,
})

// ─── Logger ──────────────────────────────────────────────────

const logger = createLogger({
  level: config.logging.level,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    json()
  ),
  transports: [
    // General logs
    new DailyRotateFile(fileTransportOptions('combined', 'info')),
    // Error logs only
    new DailyRotateFile(fileTransportOptions('error', 'error')),
    // Payment audit logs (separate file for compliance)
    new DailyRotateFile({
      ...fileTransportOptions('payments', 'info'),
      filename: path.join(config.logging.dir, 'payments-%DATE%.log'),
    }),
  ],
  exceptionHandlers: [
    new DailyRotateFile(fileTransportOptions('exceptions', 'error')),
  ],
  rejectionHandlers: [
    new DailyRotateFile(fileTransportOptions('rejections', 'error')),
  ],
})

// Console output kwa development
if (!config.app.isProduction) {
  logger.add(new transports.Console({
    format: combine(
      colorize(),
      timestamp({ format: 'HH:mm:ss' }),
      devFormat
    ),
  }))
}

// ─── Specialized Loggers ─────────────────────────────────────

/**
 * Rek payment webhook request (kwa audit trail)
 */
logger.payment = (data) => {
  logger.info('PAYMENT_EVENT', { ...data, _type: 'payment' })
}

/**
 * Rekodi admin action (audit log)
 */
logger.audit = (adminId, action, details = {}) => {
  logger.info('AUDIT', { adminId, action, details, _type: 'audit' })
}

/**
 * Rekodi usalama/security events
 */
logger.security = (event, data = {}) => {
  logger.warn('SECURITY', { event, ...data, _type: 'security' })
}

module.exports = logger
