'use strict'

const { PrismaClient } = require('@prisma/client')
const logger = require('../utils/logger')

// ─── Singleton Pattern ───────────────────────────────────────
// Tunahakikisha instance moja tu ya PrismaClient inatumiwa katika app nzima

let prisma

if (global.__prisma) {
  prisma = global.__prisma
} else {
  prisma = new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  })

  // Log slow queries (> 1 sekunde) kwa production debugging
  prisma.$on('query', (e) => {
    if (e.duration > 1000) {
      logger.warn('SLOW_QUERY', {
        query: e.query,
        duration: e.duration,
        params: e.params,
      })
    }
  })

  prisma.$on('error', (e) => {
    logger.error('PRISMA_ERROR', { message: e.message, target: e.target })
  })

  // Cache kwenye global kwa development (kuzuia hot-reload connections nyingi)
  if (process.env.NODE_ENV !== 'production') {
    global.__prisma = prisma
  }
}

/**
 * Unganisha database na uthibitishe connection
 */
async function connectDatabase() {
  try {
    await prisma.$connect()
    logger.info('✅ Database imeunganishwa kwa mafanikio')
  } catch (error) {
    logger.error('❌ Kushindwa kuunganisha database', { error: error.message })
    throw error
  }
}

/**
 * Kata muunganiko wa database kwa usalama
 */
async function disconnectDatabase() {
  try {
    await prisma.$disconnect()
    logger.info('Database imekatishwa')
  } catch (error) {
    logger.error('Hitilafu wakati wa kukata database', { error: error.message })
  }
}

module.exports = { prisma, connectDatabase, disconnectDatabase }
