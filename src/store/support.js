'use strict'

const { Markup } = require('telegraf')
const { prisma } = require('../database')
const { escapeMarkdown } = require('../utils/formatting')
const { sanitizeText } = require('../utils/validation')
const { notifyAdmins } = require('../services/notificationService')
const config = require('../config')
const logger = require('../utils/logger')

function registerSupportHandlers(bot) {
  // ─── Support Main ─────────────────────────────────────────────
  bot.command('support', async (ctx) => {
    await showSupportMenu(ctx)
  })

  bot.action('store:support', async (ctx) => {
    await ctx.answerCbQuery()
    await showSupportMenu(ctx)
  })

  // ─── New Ticket ────────────────────────────────────────────────
  bot.action('store:support:new', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'

    ctx.session.userWizard = { scene: 'support', step: 'subject', data: {} }

    await ctx.editMessageText(
      lang === 'sw'
        ? '💬 *Fungua Tiketi Mpya ya Msaada*\n\nAndika *mada* ya tatizo lako:'
        : '💬 *Open a New Support Ticket*\n\nEnter the *subject* of your issue:',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '❌ Ghairi' : '❌ Cancel', 'store:support')]]),
      }
    )
  })

  // ─── My Tickets ────────────────────────────────────────────────
  bot.action('store:support:tickets', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    const tickets = await prisma.supportTicket.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    })

    if (tickets.length === 0) {
      await ctx.editMessageText(
        lang === 'sw' ? '💬 Huna tiketi za msaada bado.' : '💬 You have no support tickets yet.',
        Markup.inlineKeyboard([[Markup.button.callback('◀️', 'store:support')]])
      )
      return
    }

    const statusIcons = { open: '🟡', in_progress: '🔵', resolved: '✅', closed: '⚫' }

    let text = lang === 'sw' ? '💬 *Tiketi Zangu za Msaada:*\n\n' : '💬 *My Support Tickets:*\n\n'
    const buttons = []

    for (const t of tickets) {
      const icon = statusIcons[t.status] || '❓'
      text += `${icon} *#${t.id}* — ${escapeMarkdown(t.subject.substring(0, 40))}\n`

      if (t.adminReply) {
        text += `_${lang === 'sw' ? 'Jibu' : 'Reply'}: ${escapeMarkdown(t.adminReply.substring(0, 100))}_\n`
      }
      text += '\n'
    }

    buttons.push([Markup.button.callback(lang === 'sw' ? '➕ Tiketi Mpya' : '➕ New Ticket', 'store:support:new')])
    buttons.push([Markup.button.callback('◀️', 'store:support')])

    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) })
  })

  // ─── Admin: Reply to Ticket ───────────────────────────────────
  bot.action(/^admin:ticket:reply:(\d+)$/, async (ctx) => {
    // Thibitisha ni admin
    const { isAdmin } = require('../middlewares/auth')

    const ticketId = parseInt(ctx.match[1])
    await ctx.answerCbQuery()

    ctx.session.adminWizard = { scene: 'replyTicket', step: 'message', data: { ticketId } }

    await ctx.editMessageText(
      `💬 *Jibu Tiketi \\#${ticketId}*\n\nAndika jibu lako:`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Ghairi', 'admin:menu')]]),
      }
    )
  })
}

// ─── Support Wizard Handler ───────────────────────────────────

async function handleSupportWizard(ctx) {
  const wizard = ctx.session?.userWizard
  if (!wizard || wizard.scene !== 'support') return false

  const text = ctx.message?.text?.trim()
  const lang = ctx.session?.language || 'sw'

  if (wizard.step === 'subject') {
    if (!text || text.length < 3) {
      await ctx.reply(lang === 'sw' ? '⚠️ Mada lazima iwe na herufi angalau 3.' : '⚠️ Subject must be at least 3 characters.')
      return true
    }
    wizard.data.subject = sanitizeText(text).substring(0, 100)
    wizard.step = 'message'

    await ctx.reply(
      lang === 'sw'
        ? `✅ Mada: *${escapeMarkdown(wizard.data.subject)}*\n\nSasa andika *ujumbe* wako kamili\\:`
        : `✅ Subject: *${escapeMarkdown(wizard.data.subject)}*\n\nNow write your *full message*\\:`,
      { parse_mode: 'MarkdownV2' }
    )
    return true
  }

  if (wizard.step === 'message') {
    if (!text || text.length < 10) {
      await ctx.reply(lang === 'sw' ? '⚠️ Ujumbe lazima uwe na herufi angalau 10.' : '⚠️ Message must be at least 10 characters.')
      return true
    }

    const user = await getDbUser(ctx.from.id)
    if (!user) {
      ctx.session.userWizard = null
      return true
    }

    wizard.data.message = sanitizeText(text).substring(0, 2000)
    ctx.session.userWizard = null

    // Unda tiketi
    const ticket = await prisma.supportTicket.create({
      data: {
        userId: user.id,
        subject: wizard.data.subject,
        message: wizard.data.message,
      },
    })

    // Notify admins
    const userName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || String(ctx.from.id)
    await notifyAdmins(
      ctx.telegram,
      `📨 *Tiketi Mpya \\#${ticket.id}*\n\n` +
      `👤 Kutoka: ${escapeMarkdown(userName)}\n` +
      `📝 Mada: ${escapeMarkdown(ticket.subject)}\n` +
      `💬 Ujumbe: ${escapeMarkdown(ticket.message.substring(0, 200))}\n\n` +
      `Jibu: /admin -> Msaada`
    ).catch(() => {})

    await ctx.reply(
      lang === 'sw'
        ? `✅ *Tiketi \\#${ticket.id} Imefunguliwa\\!*\n\nTutajibu haraka iwezekanavyo\\. Asante kwa kuwasiliana nasi\\.`
        : `✅ *Ticket \\#${ticket.id} Opened\\!*\n\nWe'll respond as soon as possible\\. Thank you for contacting us\\.`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '📋 Tiketi Zangu' : '📋 My Tickets', 'store:support:tickets')]]),
      }
    )

    return true
  }

  return false
}

// ─── Admin Ticket Reply Handler ───────────────────────────────

async function handleAdminTicketReply(ctx) {
  const wizard = ctx.session?.adminWizard
  if (!wizard || wizard.scene !== 'replyTicket') return false

  const text = ctx.message?.text?.trim()

  const ticket = await prisma.supportTicket.update({
    where: { id: wizard.data.ticketId },
    data: {
      adminReply: text,
      status: 'resolved',
    },
    include: { user: { select: { telegramId: true, language: true } } },
  })

  ctx.session.adminWizard = null

  // Tuma jibu kwa mtumiaji
  const lang = ticket.user.language || 'sw'
  const replyMsg = lang === 'sw'
    ? `📨 *Jibu kutoka Msaada — Tiketi \\#${ticket.id}*\n\n_${escapeMarkdown(text)}_`
    : `📨 *Support Reply — Ticket \\#${ticket.id}*\n\n_${escapeMarkdown(text)}_`

  await ctx.telegram.sendMessage(
    Number(ticket.user.telegramId),
    replyMsg,
    { parse_mode: 'MarkdownV2' }
  ).catch(err => logger.error('Failed to send ticket reply', { error: err.message }))

  await ctx.reply(`✅ Jibu limetumwa kwa Tiketi #${ticket.id}`)
  return true
}

// ─── Support Menu Display ─────────────────────────────────────

async function showSupportMenu(ctx) {
  const lang = ctx.session?.language || 'sw'
  const support = await require('../admin/settings').getSetting('support_contact').catch(() => null)

  const text = lang === 'sw'
    ? [
        `💬 *Msaada wa Wateja*`,
        ``,
        `Je, una swali au tatizo? Tuma tiketi na tutajibu haraka\\!`,
        support ? `\n📞 Direct: ${escapeMarkdown(support)}` : '',
      ].filter(Boolean).join('\n')
    : [
        `💬 *Customer Support*`,
        ``,
        `Have a question or issue? Submit a ticket and we'll respond quickly\\!`,
        support ? `\n📞 Direct: ${escapeMarkdown(support)}` : '',
      ].filter(Boolean).join('\n')

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(lang === 'sw' ? '📝 Fungua Tiketi' : '📝 Open Ticket', 'store:support:new')],
    [Markup.button.callback(lang === 'sw' ? '📋 Tiketi Zangu' : '📋 My Tickets', 'store:support:tickets')],
    [Markup.button.callback(lang === 'sw' ? '◀️ Rudi' : '◀️ Back', 'store:menu')],
  ])

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
  }
}

async function getDbUser(telegramId) {
  return prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true },
  })
}

module.exports = {
  registerSupportHandlers,
  handleSupportWizard,
  handleAdminTicketReply,
}
