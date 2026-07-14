'use strict'

const { prisma } = require('../database')
const { extractWatermark } = require('../utils/watermark')
const logger = require('../utils/logger')
const { clearWizardState } = require('../middlewares/session')

async function handleReportLeakWizard(ctx) {
  const wizard = ctx.session?.userWizard
  if (!wizard || wizard.scene !== 'reportLeak') return false

  const lang = ctx.session.language || 'sw'

  if (ctx.message?.text === '/cancel') {
    await clearWizardState(ctx, 'user')
    await ctx.reply(lang === 'sw' ? '❌ Kughairi kumefanikiwa.' : '❌ Cancelled.')
    return true
  }

  let extractedInfo = { orderId: null, userId: null }

  if (ctx.message?.text) {
    extractedInfo = extractWatermark(ctx.message.text)
  } else if (ctx.message?.document) {
    // For PDF files, we'd need to extract text and check for watermark.
    // For now, we will just record the fileTelegramId for the admin to review manually
    // because extracting text from PDF requires another heavy package (like pdf-parse).
    extractedInfo = { orderId: null, userId: null, fileId: ctx.message.document.file_id }
  } else {
    await ctx.reply(
      lang === 'sw'
        ? '⚠️ Tafadhali tuma ujumbe wa maandishi (text) au faili (document).'
        : '⚠️ Please send a text message or a document.'
    )
    return true
  }

  // Create LeakReport record
  const report = await prisma.leakReport.create({
    data: {
      reporterId: ctx.from.id,
      fileTelegramId: extractedInfo.fileId || null,
      notes: extractedInfo.orderId 
        ? `Watermark found! Order ID: ${extractedInfo.orderId}, User ID: ${extractedInfo.userId}` 
        : `No watermark found automatically. Manual review required.`,
    }
  })

  // Notify admin
  const { getSetting } = require('../admin/settings')
  const supportGroup = await getSetting('support_group_id').catch(() => null)
  if (supportGroup) {
    try {
      const msg = `🚨 *New Leak Report (ID: #${report.id})*\nReporter: [${ctx.from.first_name}](tg://user?id=${ctx.from.id})\n\nResult: ${report.notes}`
      if (extractedInfo.fileId) {
        await ctx.telegram.sendDocument(supportGroup, extractedInfo.fileId, { caption: msg, parse_mode: 'Markdown' })
      } else {
        await ctx.telegram.sendMessage(supportGroup, msg, { parse_mode: 'Markdown' })
      }
    } catch (e) {
      logger.error('Failed to notify admin about leak report', { error: e.message })
    }
  }

  await clearWizardState(ctx, 'user')
  await ctx.reply(
    lang === 'sw'
      ? '✅ Asante! Ripoti yako imepokelewa na itafanyiwa kazi.'
      : '✅ Thank you! Your report has been received and will be reviewed.'
  )
  
  return true
}

module.exports = {
  handleReportLeakWizard,
}
