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
    providerToken: optional('PAYMENT_PROVIDER_TOKEN', ''),
    binance: {
      apiKey: optional('BINANCE_API_KEY', ''),
      apiSecret: optional('BINANCE_API_SECRET', ''),
      baseUrl: optional('BINANCE_BASE_URL', 'https://bpay.binanceapi.com'),
      usdtToTzsRate: parseInt(optional('USDT_TO_TZS_RATE', '2600'), 10),
      payId: optional('BINANCE_PAY_ID', '263344433'),
    },
    usdt: {
      trc20Address: optional('USDT_TRC20_ADDRESS', 'TYt9SJtz3cJhnq5wgEe3N9H7fa48GvKhx5'),
      bep20Address: optional('USDT_BEP20_ADDRESS', '0x0bacd562860a87f8fc54be1dec52fba6c47f7ed2'),
    },
  },

  // VIP Settings
  vip: {
    priceTzs: parseInt(optional('VIP_PRICE_TZS', '10000'), 10),
    discountPercent: parseInt(optional('VIP_DISCOUNT_PERCENT', '15'), 10),
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
    usdToTzsRate: parseInt(optional('USD_TO_TZS_RATE', '2600'), 10),
  },

  // Referral
  referral: {
    commissionTzs: parseInt(optional('REFERRAL_COMMISSION_TZS', '2000'), 10), // Default TZS 2000 per referral purchase
  },

  // Jobs
  jobs: {
    abandonedCartReminderHours: parseInt(optional('ABANDONED_CART_REMINDER_HOURS', '2'), 10),
  },
}

module.exports = config
