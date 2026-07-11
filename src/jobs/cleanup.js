'use strict'

const { prisma } = require('../database')
const logger = require('../utils/logger')
const fs = require('fs')
const path = require('path')
const config = require('../config')

/**
 * Kazi ya usafi wa kila siku
 * - Futa sessions zilizokwisha
 * - Futa temp files
 * - Futa pending orders za zamani
 * - Archive logs za zamani
 */
async function cleanupJob(data = {}) {
  const now = new Date()
  logger.info('Starting daily cleanup job', { timestamp: now.toISOString() })

  let results = {}

  // ─── 1. Futa Pending Orders Za Zamani (zaidi ya saa 24) ──────
  try {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const deleted = await prisma.order.deleteMany({
      where: {
        status: 'pending',
        createdAt: { lt: cutoff },
      },
    })
    results.expiredOrders = deleted.count
    logger.info(`Deleted ${deleted.count} expired pending orders`)
  } catch (err) {
    logger.error('Cleanup: Failed to delete expired orders', { error: err.message })
  }

  // ─── 2. Futa Cart Items Za Zamani (zaidi ya siku 7) ──────────
  try {
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const deleted = await prisma.cartItem.deleteMany({
      where: { updatedAt: { lt: cutoff } },
    })
    results.oldCartItems = deleted.count
    logger.info(`Deleted ${deleted.count} old cart items`)
  } catch (err) {
    logger.error('Cleanup: Failed to delete old cart items', { error: err.message })
  }

  // ─── 3. Futa Temp Files Zisizotumiwa ─────────────────────────
  try {
    const tempDir = path.join(config.storage.uploadDir, 'temp')
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir)
      let deletedFiles = 0

      for (const file of files) {
        const filePath = path.join(tempDir, file)
        const stat = fs.statSync(filePath)
        const ageMs = now - stat.mtime

        if (ageMs > 24 * 60 * 60 * 1000) { // Zaidi ya saa 24
          fs.unlinkSync(filePath)
          deletedFiles++
        }
      }

      results.tempFiles = deletedFiles
      logger.info(`Deleted ${deletedFiles} temp files`)
    }
  } catch (err) {
    logger.error('Cleanup: Failed to delete temp files', { error: err.message })
  }

  // ─── 4. Weka Cart notifiedAt=null kwa items mpya ─────────────
  try {
    // Reset abandoned cart notification flag kwa items zilizobadilishwa wiki iliyopita
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    await prisma.cartItem.updateMany({
      where: {
        notifiedAt: { lt: weekAgo },
      },
      data: { notifiedAt: null },
    })
  } catch (err) {
    logger.error('Cleanup: Failed to reset cart notifications', { error: err.message })
  }

  logger.info('Daily cleanup job completed', results)
  return results
}

module.exports = { cleanupJob }
