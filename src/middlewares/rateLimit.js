'use strict'

const { Redis } = require('ioredis')
const config = require('../config')
const logger = require('../utils/logger')

// ─── Redis Client kwa Rate Limiting ─────────────────────────

let redis
function getRedis() {
  if (!redis) {
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    })
    redis.on('error', (err) => {
      logger.error('Redis rate limit error', { error: err.message })
    })
  }
  return redis
}

// ─── Rate Limiter Factory ────────────────────────────────────

/**
 * Tengeneza rate limiter middleware
 * @param {object} options
 * @param {number} options.maxRequests - Idadi ya juu ya maombi
 * @param {number} options.windowSeconds - Kipindi cha muda (sekunde)
 * @param {string} options.keyPrefix - Prefix ya Redis key
 * @param {boolean} options.skipForAdmin - Skip kwa admin au la
 * @returns {Function} Telegraf middleware
 */
function createRateLimiter({
  maxRequests = 30,
  windowSeconds = 60,
  keyPrefix = 'rl',
  skipForAdmin = true,
} = {}) {
  return async (ctx, next) => {
    const userId = ctx.from?.id
    if (!userId) return next()

    // Admins wana uhuru (mara nyingi wanaingiliana na bot zaidi)
    if (skipForAdmin && config.admin.ids.includes(userId)) return next()

    const key = `${keyPrefix}:${userId}`
    const client = getRedis()

    try {
      const pipeline = client.pipeline()
      pipeline.incr(key)
      pipeline.expire(key, windowSeconds)
      const results = await pipeline.exec()

      const count = results[0][1] // Idadi ya sasa

      if (count > maxRequests) {
        const ttl = await client.ttl(key)
        logger.security('RATE_LIMIT_HIT', {
          userId,
          count,
          maxRequests,
          ttl,
          keyPrefix,
        })

        // Jibu tu mara ya kwanza (si kila mara) ili kuzuia spam ya messages za onyo
        if (count === maxRequests + 1) {
          const waitSeconds = Math.max(ttl, 1)
          await ctx.reply(
            `⚠️ Umepeleka maombi mengi sana\\. Subiri sekunde *${waitSeconds}* kisha jaribu tena\\.`,
            { parse_mode: 'MarkdownV2' }
          ).catch(() => {})
        }

        return // Zima callback/answer bila jibu jingine
      }
    } catch (err) {
      // Kama Redis iko chini, ruhusu request kupita (graceful degradation)
      logger.error('Rate limit check failed', { error: err.message })
    }

    return next()
  }
}

// ─── Specialized Rate Limiters ────────────────────────────────

/** Rate limit ya kawaida kwa mtumiaji: maombi 30 kwa dakika */
const userRateLimit = createRateLimiter({
  maxRequests: 30,
  windowSeconds: 60,
  keyPrefix: 'rl:user',
  skipForAdmin: true,
})

/** Rate limit ya checkout: majaribio 5 kwa dakika */
const checkoutRateLimit = createRateLimiter({
  maxRequests: 5,
  windowSeconds: 60,
  keyPrefix: 'rl:checkout',
  skipForAdmin: false,
})

/** Rate limit ya search: maombi 10 kwa dakika */
const searchRateLimit = createRateLimiter({
  maxRequests: 10,
  windowSeconds: 60,
  keyPrefix: 'rl:search',
  skipForAdmin: true,
})

/** Rate limit ya re-download content: maombi 3 kwa dakika */
const contentRateLimit = createRateLimiter({
  maxRequests: 3,
  windowSeconds: 60,
  keyPrefix: 'rl:content',
  skipForAdmin: false,
})

/**
 * Anti-spam: Angalia kama mtumiaji anajaribu ku-spam messages haraka sana
 * (kwa example wakati wa wizard wa multi-step)
 */
const antiSpam = createRateLimiter({
  maxRequests: 20,
  windowSeconds: 10,
  keyPrefix: 'rl:spam',
  skipForAdmin: true,
})

/** Global API rate limit (alias ya userRateLimit kwa index.js) */
const apiRateLimit = userRateLimit

module.exports = {
  createRateLimiter,
  apiRateLimit,
  userRateLimit,
  checkoutRateLimit,
  searchRateLimit,
  contentRateLimit,
  antiSpam,
}
