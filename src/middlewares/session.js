'use strict'

const { Redis } = require('ioredis')
const { session } = require('telegraf')
const config = require('../config')
const logger = require('../utils/logger')

// ─── Redis Client kwa Sessions ───────────────────────────────

const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
})

redis.on('error', (err) => {
  logger.error('Redis session error', { error: err.message })
})

redis.on('connect', () => {
  logger.info('✅ Redis imeunganishwa (Sessions)')
})

// Session TTL: wiki 1 kwa default
const SESSION_TTL = config.app.sessionTtlHours * 3600

// ─── Redis Session Store ─────────────────────────────────────

// ─── Redis Session Store Generator ─────────────────────────────

/**
 * Session middleware generator with Redis backend
 * @param {import('ioredis').Redis} redisClient - Redis client instance
 */
function redisSession(redisClient) {
  const store = {
    async get(key) {
      try {
        const val = await redisClient.get(`sess:${key}`)
        return val ? JSON.parse(val) : undefined
      } catch (err) {
        logger.error('Session get error', { key, error: err.message })
        return undefined
      }
    },

    async set(key, value) {
      try {
        await redisClient.setex(`sess:${key}`, SESSION_TTL, JSON.stringify(value))
      } catch (err) {
        logger.error('Session set error', { key, error: err.message })
      }
    },

    async delete(key) {
      try {
        await redisClient.del(`sess:${key}`)
      } catch (err) {
        logger.error('Session delete error', { key, error: err.message })
      }
    },
  }

  return session({
    store,
    getSessionKey: (ctx) => {
      // Tumia chat ID + user ID kama key ya kipekee
      const chatId = ctx.chat?.id || ctx.from?.id
      const userId = ctx.from?.id
      return `${chatId}:${userId}`
    },
    defaultSession: () => ({
      language: 'sw',
      adminWizard: null,
      userWizard: null,
      lastCartReminder: null,
    }),
  })
}

/**
 * Futa wizard state ya session (baada ya wizard kukamilika au kufutwa)
 */
async function clearWizardState(ctx, type = 'user') {
  if (type === 'admin') {
    ctx.session.adminWizard = null
  } else {
    ctx.session.userWizard = null
  }
}

/**
 * Pata language ya mtumiaji kutoka session
 */
function getUserLanguage(ctx) {
  return ctx.session?.language || 'sw'
}

module.exports = {
  redisSession,
  clearWizardState,
  getUserLanguage,
}
