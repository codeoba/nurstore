'use strict'

const { Markup } = require('telegraf')
const { isAdmin, auditLog } = require('../middlewares/auth')
const { escapeMarkdown } = require('../utils/formatting')
const { prisma } = require('../database')
const { sanitizeText, isValidTelegramId } = require('../utils/validation')
const config = require('../config')
const logger = require('../utils/logger')

// ─── Settings Keys ────────────────────────────────────────────
const SETTINGS = {
  WELCOME_MESSAGE: 'welcome_message',
  SUPPORT_CONTACT: 'support_contact',
  TERMS: 'terms_and_conditions',
  MAINTENANCE: 'maintenance_mode',
}

function registerAdminSettingsHandlers(bot) {
  bot.action('admin:settings', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await showSettingsMenu(ctx)
  })

  // ─── Welcome Message ─────────────────────────────────────────
  bot.action('admin:settings:welcome', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const current = await getSetting(SETTINGS.WELCOME_MESSAGE)
    ctx.session.adminWizard = { scene: 'editSetting', step: 'value', data: { key: SETTINGS.WELCOME_MESSAGE } }
    await ctx.editMessageText(
      `⚙️ *Badilisha Welcome Message*\n\n` +
      `*Sasa hivi:*\n${escapeMarkdown(current || 'Haijawekwa')}\n\n` +
      `Andika welcome message mpya:`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Ghairi', 'admin:settings')]]),
      }
    )
  })

  // ─── Support Contact ─────────────────────────────────────────
  bot.action('admin:settings:support', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const current = await getSetting(SETTINGS.SUPPORT_CONTACT)
    ctx.session.adminWizard = { scene: 'editSetting', step: 'value', data: { key: SETTINGS.SUPPORT_CONTACT } }
    await ctx.editMessageText(
      `⚙️ *Badilisha Support Contact*\n\n` +
      `*Sasa hivi:* ${escapeMarkdown(current || 'Haijawekwa')}\n\n` +
      `Andika username au link ya support \\(mfano: @SupportUsername\\):`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Ghairi', 'admin:settings')]]),
      }
    )
  })

  // ─── Maintenance Mode ─────────────────────────────────────────
  bot.action('admin:settings:maintenance', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const current = await getSetting(SETTINGS.MAINTENANCE)
    const isOn = current === 'true'

    await setSetting(SETTINGS.MAINTENANCE, isOn ? 'false' : 'true')
    await auditLog(ctx.from.id, 'settings.maintenance', { enabled: !isOn })

    await ctx.answerCbQuery(
      isOn ? '✅ Maintenance mode imezimwa' : '🔧 Maintenance mode imewashwa',
      { show_alert: true }
    )
    await showSettingsMenu(ctx)
  })

  // ─── Multi-Admin Management ────────────────────────────────────
  bot.action('admin:settings:admins', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await showAdminsList(ctx)
  })

  bot.action('admin:settings:admin:add', isAdmin, async (ctx) => {
    // Superadmin tu anaweza kuongeza admin
    if (!ctx.isSuperAdmin) {
      await ctx.answerCbQuery('❌ Superadmin tu anaweza kuongeza admin.', { show_alert: true })
      return
    }
    await ctx.answerCbQuery()
    ctx.session.adminWizard = { scene: 'addAdmin', step: 'telegram_id', data: {} }
    await ctx.editMessageText(
      '👨‍💼 *Ongeza Admin Mpya*\n\nAndika Telegram ID ya admin mpya:\n_Mfano: 123456789_',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Ghairi', 'admin:settings:admins')]]),
      }
    )
  })

  bot.action(/^admin:settings:admin:remove:(\d+)$/, isAdmin, async (ctx) => {
    if (!ctx.isSuperAdmin) {
      await ctx.answerCbQuery('❌ Superadmin tu anaweza kufuta admin.', { show_alert: true })
      return
    }
    const adminId = parseInt(ctx.match[1])
    await prisma.admin.delete({ where: { id: adminId } })
    await auditLog(ctx.from.id, 'admin.removed', { adminId })
    await ctx.answerCbQuery('✅ Admin amefutwa')
    await showAdminsList(ctx)
  })
}

// ─── Settings Wizard Handler ──────────────────────────────────

async function handleAdminSettingsWizard(ctx) {
  const wizard = ctx.session?.adminWizard
  if (!wizard) return false

  const text = ctx.message?.text?.trim()

  // Edit setting
  if (wizard.scene === 'editSetting' && wizard.step === 'value') {
    await setSetting(wizard.data.key, sanitizeText(text))
    await auditLog(ctx.from.id, `settings.${wizard.data.key}`, {})
    ctx.session.adminWizard = null
    await ctx.reply(
      '✅ Mipangilio imehifadhiwa\\!',
      { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Mipangilio', 'admin:settings')]]) }
    )
    return true
  }

  // Add admin
  if (wizard.scene === 'addAdmin') {
    if (wizard.step === 'telegram_id') {
      const telegramId = parseInt(text)
      if (!isValidTelegramId(telegramId)) {
        await ctx.reply('⚠️ Telegram ID si sahihi. Andika nambari tu:')
        return true
      }
      wizard.data.telegramId = telegramId
      wizard.step = 'role'
      await ctx.reply(
        'Chagua role ya admin:',
        Markup.inlineKeyboard([
          [
            Markup.button.callback('👑 Superadmin', 'admin:wizard:role:superadmin'),
            Markup.button.callback('📋 Moderator', 'admin:wizard:role:moderator'),
          ],
        ])
      )
      return true
    }
    return false
  }

  return false
}

// ─── Callback for role selection in add admin wizard ─────────

function registerAddAdminRoleCallback(bot) {
  bot.action(/^admin:wizard:role:(superadmin|moderator)$/, isAdmin, async (ctx) => {
    const wizard = ctx.session?.adminWizard
    if (!wizard || wizard.scene !== 'addAdmin') return

    const role = ctx.match[1]
    wizard.data.role = role
    ctx.session.adminWizard = null

    try {
      const admin = await prisma.admin.upsert({
        where: { telegramId: BigInt(wizard.data.telegramId) },
        update: { role },
        create: {
          telegramId: BigInt(wizard.data.telegramId),
          role,
          addedBy: ctx.from.id,
        },
      })

      await auditLog(ctx.from.id, 'admin.added', { adminId: admin.id, role })
      await ctx.answerCbQuery('✅ Admin ameongezwa!')
      await ctx.editMessageText(
        `✅ *Admin Ameongezwa\\!*\n\nID: \`${wizard.data.telegramId}\`\nRole: ${role}`,
        {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Admins', 'admin:settings:admins')]]),
        }
      )
    } catch (err) {
      await ctx.answerCbQuery(`❌ Hitilafu: ${err.message}`, { show_alert: true })
    }
  })
}

// ─── Display Functions ────────────────────────────────────────

async function showSettingsMenu(ctx) {
  const [maintenance, welcome, support] = await Promise.all([
    getSetting(SETTINGS.MAINTENANCE),
    getSetting(SETTINGS.WELCOME_MESSAGE),
    getSetting(SETTINGS.SUPPORT_CONTACT),
  ])

  const maintenanceStatus = maintenance === 'true' ? '🔴 Imewashwa' : '🟢 Imezimwa'

  const text = [
    `⚙️ *Mipangilio ya Bot*`,
    ``,
    `🔧 Maintenance Mode: ${maintenanceStatus}`,
    `💬 Welcome Message: ${welcome ? '✅ Imewekwa' : '❌ Haijawekwa'}`,
    `📞 Support Contact: ${support ? escapeMarkdown(support) : '❌ Haijawekwa'}`,
    `👤 Admins: ${config.admin.ids.length} superadmin\\(s\\) + DB admins`,
  ].join('\n')

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💬 Welcome Message', 'admin:settings:welcome')],
      [Markup.button.callback('📞 Support Contact', 'admin:settings:support')],
      [Markup.button.callback(
        maintenance === 'true' ? '✅ Zima Maintenance' : '🔧 Washa Maintenance',
        'admin:settings:maintenance'
      )],
      [Markup.button.callback('👨‍💼 Admins', 'admin:settings:admins')],
      [Markup.button.callback('◀️ Rudi', 'admin:menu')],
    ]),
  })
}

async function showAdminsList(ctx) {
  const dbAdmins = await prisma.admin.findMany({ orderBy: { createdAt: 'asc' } })

  let text = '👨‍💼 *Admins:*\n\n'
  text += `*Super Admins \\(env\\):*\n`
  config.admin.ids.forEach(id => { text += `• \`${id}\`\n` })

  if (dbAdmins.length > 0) {
    text += `\n*DB Admins:*\n`
    dbAdmins.forEach(a => {
      const name = a.username ? `@${a.username}` : String(a.telegramId)
      text += `• ${escapeMarkdown(name)} — ${a.role}\n`
    })
  }

  const buttons = dbAdmins.map(a => [
    Markup.button.callback(`🗑️ Futa ${a.role}:${a.telegramId}`, `admin:settings:admin:remove:${a.id}`)
  ])
  buttons.push([Markup.button.callback('➕ Ongeza Admin', 'admin:settings:admin:add')])
  buttons.push([Markup.button.callback('◀️ Mipangilio', 'admin:settings')])

  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) })
}

// ─── Setting Helpers ──────────────────────────────────────────

async function getSetting(key) {
  const setting = await prisma.botSetting.findUnique({ where: { key } })
  return setting?.value || null
}

async function setSetting(key, value) {
  return prisma.botSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
}

module.exports = {
  registerAdminSettingsHandlers,
  handleAdminSettingsWizard,
  registerAddAdminRoleCallback,
  getSetting,
}
