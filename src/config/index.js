'use strict'

require('dotenv').config()

// ─── Validation ya Configuration ────────────────────────────

function required(name) {
  const val = process.env[name]
  if (!val) throw new Error(`❌ Environment variable ${name} inahitajika! Angalia .env file`)
  return val
}

function optional(name, defaultValue = '') {
  return process.env[name] || defaultValue
}

function requiredInt(name) {
  const val = process.env[name]
  if (!val) throw new Error(`❌ Environment variable ${name} inahitajika!`)
  const num = parseInt(val, 10)
  if (isNaN(num)) throw new Error(`❌ ${name} lazima iwe nambari`)
  return num
}

// ─── Admin IDs Parser ────────────────────────────────────────

const rawAdminIds = required('ADMIN_IDS')
const ADMIN_IDS = rawAdminIds
  .split(',')
  .map(id => id.trim())
  .filter(Boolean)
  .map(id => {
    const num = parseInt(id, 10)
    if (isNaN(num)) throw new Error(`❌ Admin ID si sahihi: ${id}`)
    return num
  })

if (ADMIN_IDS.length === 0) {
  throw new Error('❌ ADMIN_IDS lazima iwe na angalau ID moja ya admin')
}

// ─── Main Config Object ─────────────────────────────────────

const config = {
  // Bot
  bot: {
    token: required('BOT_TOKEN'),
    storeName: optional('STORE_NAME', 'Duka la Digital'),
  },

  // Admins
  admin: {
    ids: ADMIN_IDS, // [number]
  },

  // Database
  database: {
    url: required('DATABASE_URL'),
  },

  // Redis
  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },

  // Payments
  payments: {
    providerToken: optional('PAYMENT_PROVIDER_TOKEN', ''), // tupu = Stars tu
    starsOnly: !process.env.PAYMENT_PROVIDER_TOKEN, // true kama hakuna provider token
  },

  // File Storage
  storage: {
    uploadDir: optional('UPLOAD_DIR', './uploads'),
    maxFileSizeMB: parseInt(optional('MAX_FILE_SIZE_MB', '500'), 10),
    signedUrlExpiryMinutes: parseInt(optional('SIGNED_URL_EXPIRY_MINUTES', '15'), 10),
  },

  // App
  app: {
    env: optional('NODE_ENV', 'development'),
    isProduction: optional('NODE_ENV', 'development') === 'production',
    sessionTtlHours: parseInt(optional('SESSION_TTL_HOURS', '168'), 10),
    rateLimitRpm: parseInt(optional('RATE_LIMIT_RPM', '30'), 10),
  },

  // Logging
  logging: {
    level: optional('LOG_LEVEL', 'info'),
    dir: optional('LOG_DIR', './logs'),
  },

  // Backup
  backup: {
    dir: optional('BACKUP_DIR', './backups'),
  },

  // Currency
  currency: {
    tzsSPerStar: parseInt(optional('TZS_PER_STAR', '32'), 10),
  },

  // Referral
  referral: {
    commissionStars: parseInt(optional('REFERRAL_COMMISSION_STARS', '5'), 10),
  },

  // Jobs
  jobs: {
    abandonedCartReminderHours: parseInt(optional('ABANDONED_CART_REMINDER_HOURS', '2'), 10),
  },
}

module.exports = config
