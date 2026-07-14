'use strict'

const config = require('../config')
const { prisma } = require('../database')
const logger = require('./logger')

/**
 * Tuma ujumbe wa tahadhari kwa Admins wote
 * @param {import('telegraf').Telegraf} bot 
 * @param {string} message 
 */
async function sendAdminAlert(bot, message) {
  try {
    // Kusanya admins wote kutoka .env na Database
    const superAdmins = config.admin.ids.map(id => String(id))
    
    let dbAdmins = []
    try {
      const admins = await prisma.admin.findMany({
        select: { telegramId: true }
      })
      dbAdmins = admins.map(a => String(a.telegramId))
    } catch (err) {
      // Ignored
    }

    // Changanya na ondoa duplicates
    const allAdmins = [...new Set([...superAdmins, ...dbAdmins])]

    // Tuma ujumbe kwa wote
    for (const adminId of allAdmins) {
      if (!adminId) continue
      try {
        await bot.telegram.sendMessage(adminId, `🚨 *ADMIN ALERT*\n\n${message}`, {
          parse_mode: 'Markdown'
        })
      } catch (err) {
        logger.error(`Failed to send alert to admin ${adminId}`, { error: err.message })
      }
    }
  } catch (err) {
    logger.error('Failed to process sendAdminAlert', { error: err.message })
  }
}

module.exports = {
  sendAdminAlert
}
