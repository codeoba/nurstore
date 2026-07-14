'use strict'

const config = require('../config')
const { prisma } = require('../database')
const logger = require('../utils/logger')

// ─── Admin Check ─────────────────────────────────────────────

/**
 * Middleware: Angalia kama sender ni admin
 * Double layer: env ADMIN_IDS + Admins database table
 */
async function isAdmin(ctx, next) {
  const senderId = ctx.from?.id

  if (!senderId) {
    return ctx.reply('❌ Ombi halijakamilika.')
  }

  // Layer 1: Check ADMIN_IDS environment variable (superadmins)
  const isEnvAdmin = config.admin.ids.includes(senderId)

  // Layer 2: Check Admins table ya database
  let dbAdmin = null
  try {
    dbAdmin = await prisma.admin.findUnique({
      where: { telegramId: BigInt(senderId) }
    })
  } catch (err) {
    logger.error('Admin check DB error', { error: err.message, senderId })
  }

  if (!isEnvAdmin && !dbAdmin) {
    logger.security('UNAUTHORIZED_ADMIN_ACCESS', {
      telegramId: senderId,
      username: ctx.from.username,
      command: ctx.message?.text || ctx.callbackQuery?.data,
    })

    // Wateja wasijue kabisa kwamba admin panel ipo
    await ctx.reply('❌ Amri hii haijulikani.')
    return
  }

  // Ambatisha admin info kwenye context kwa matumizi mengine
  ctx.adminInfo = dbAdmin || {
    telegramId: BigInt(senderId),
    role: 'superadmin',
    permissions: {},
  }
  ctx.isSuperAdmin = isEnvAdmin

  return next()
}

/**
 * Middleware: Angalia permission maalum kwa moderator
 * Mfano: requirePermission('can_edit_products')
 */
function requirePermission(permission) {
  return async (ctx, next) => {
    // Superadmins wana ruhusa zote
    if (ctx.isSuperAdmin) return next()

    const permissions = ctx.adminInfo?.permissions || {}
    if (!permissions[permission]) {
      await ctx.answerCbQuery('❌ Huna ruhusa ya kitendo hiki.', { show_alert: true })
      return
    }

    return next()
  }
}

// ─── User Block Check ────────────────────────────────────────

/**
 * Middleware: Angalia kama mtumiaji amezuiwa (blocked)
 */
async function checkBlocked(ctx, next) {
  const telegramId = ctx.from?.id
  if (!telegramId) return next()

  // Admins hawaangaliwi (wao wenyewe ndio wanaweza block)
  if (config.admin.ids.includes(telegramId)) return next()

  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: { isBlocked: true }
    })

    if (user?.isBlocked) {
      logger.security('BLOCKED_USER_ATTEMPT', { telegramId })
      
      // Notify Admin
      try {
        const { notifyAdmins } = require('../services/notificationService')
        const username = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || String(telegramId)
        await notifyAdmins(
          ctx.telegram,
          `⚠️ *Tahadhari ya Usalama*\n\nMteja aliyefungiwa anajaribu kutumia bot.\n👤 Mteja: ${username}\n🆔 ID: \`${telegramId}\``
        )
      } catch (e) {
        // Ignored
      }

      await ctx.reply('🚫 Umezuiwa kutumia bot hii. Wasiliana na msaada kwa maelezo zaidi.')
      return
    }
  } catch (err) {
    logger.error('Block check error', { error: err.message })
    // Endelea hata kama kuna hitilafu ya DB
  }

  return next()
}

// ─── Maintenance Mode ────────────────────────────────────────

/**
 * Middleware: Angalia kama duka liko kwenye maintenance mode
 */
async function checkMaintenance(ctx, next) {
  const telegramId = ctx.from?.id

  // Admins wanapita hata wakati wa maintenance
  if (config.admin.ids.includes(telegramId)) return next()

  try {
    const setting = await prisma.botSetting.findUnique({
      where: { key: 'maintenance_mode' }
    })

    if (setting?.value === 'true') {
      await ctx.reply(
        '🔧 *Duka liko kwenye ukarabati wa muda*\n\n' +
        'Tutarudi hivi karibuni\\. Samahani kwa usumbufu\\!',
        { parse_mode: 'MarkdownV2' }
      )
      return
    }
  } catch (err) {
    logger.error('Maintenance check error', { error: err.message })
  }

  return next()
}

// ─── User Auto-Registration ──────────────────────────────────

/**
 * Middleware: Jisajili au sasisha taarifa za mtumiaji otomatiki
 */
async function autoRegisterUser(ctx, next) {
  const from = ctx.from
  if (!from || from.is_bot) return next()

  try {
    const referralCode = generateReferralCode(from.id)

    await prisma.user.upsert({
      where: { telegramId: BigInt(from.id) },
      update: {
        username: from.username,
        fullName: [from.first_name, from.last_name].filter(Boolean).join(' '),
      },
      create: {
        telegramId: BigInt(from.id),
        username: from.username,
        fullName: [from.first_name, from.last_name].filter(Boolean).join(' '),
        referralCode,
      },
    })
  } catch (err) {
    logger.error('Auto-register error', { error: err.message, userId: from.id })
  }

  return next()
}

// ─── Audit Logging ───────────────────────────────────────────

/**
 * Helper: Rekodi admin action kwenye AuditLogs table
 */
async function auditLog(adminTelegramId, action, details = {}) {
  try {
    const admin = await prisma.admin.findUnique({
      where: { telegramId: BigInt(adminTelegramId) }
    })

    // Kwa superadmins waliopo .env lakini hawako DB, skip DB log (tayari iko kwenye Winston)
    if (!admin) {
      logger.audit(adminTelegramId, action, details)
      return
    }

    await prisma.auditLog.create({
      data: {
        adminId: admin.id,
        action,
        details,
      }
    })

    logger.audit(adminTelegramId, action, details)
  } catch (err) {
    logger.error('Audit log error', { error: err.message })
  }
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Tengeneza referral code ya kipekee kutoka kwa Telegram ID
 */
function generateReferralCode(telegramId) {
  const crypto = require('crypto')
  return crypto
    .createHash('sha256')
    .update(String(telegramId) + 'store_salt_2024')
    .digest('hex')
    .substring(0, 8)
    .toUpperCase()
}

/**
 * Combined middleware: auto-register user + check if blocked
 * Hutumika kwa kila update
 */
async function attachUser(ctx, next) {
  if (!ctx.from) return next()
  await autoRegisterUser(ctx, async () => {})
  await checkBlocked(ctx, next)
}

/**
 * Middleware: Weka ctx.isSuperAdmin = true kama sender ni superadmin
 * Haitazuia - ni marker tu
 */
async function isSuperAdmin(ctx, next) {
  if (ctx.from) {
    ctx.isSuperAdmin = config.admin.ids.includes(ctx.from.id)
  }
  return next()
}

module.exports = {
  isAdmin,
  requirePermission,
  checkBlocked,
  checkMaintenance,
  autoRegisterUser,
  attachUser,
  isSuperAdmin,
  auditLog,
  generateReferralCode,
}
