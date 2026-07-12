'use strict'

const path = require('path')
const fs = require('fs')
const { prisma } = require('../database')
const { addWatermark } = require('../utils/watermark')
const logger = require('../utils/logger')
const config = require('../config')

const CHUNK_SIZE = 4000 // Telegram message character limit

// ─── Main Delivery Function ───────────────────────────────────

/**
 * Tuma bidhaa kwa mtumiaji mara baada ya malipo kuthibitika
 * @param {object} bot - Telegraf bot instance
 * @param {number} telegramUserId - Telegram ID ya mnunuzi
 * @param {object} order - Order object na items na products
 */
async function deliverOrder(bot, telegramUserId, order) {
  logger.info('Starting delivery', {
    orderId: order.id,
    telegramUserId,
    itemsCount: order.items.length,
  })

  // Tuma confirmation kwanza
  try {
    await bot.telegram.sendMessage(
      telegramUserId,
      `✅ *Malipo Yamepokelewa\\!*\n\n` +
      `🎉 Asante kwa ununuzi wako\\!\n` +
      `📋 Order \\#${order.id}\n\n` +
      `Bidhaa zako zinatumwa sasa hivi\\.\\.\\. 👇`,
      { parse_mode: 'MarkdownV2' }
    )
  } catch (err) {
    logger.error('Failed to send delivery confirmation', { error: err.message, telegramUserId })
  }

  // Tuma kila bidhaa
  let deliveredCount = 0
  for (const item of order.items) {
    const product = item.product
    if (!product) continue

    try {
      if (product.productType === 'file') {
        await deliverFile(bot, telegramUserId, product, order)
      } else if (product.productType === 'text_content') {
        await deliverTextContent(bot, telegramUserId, product, order)
      } else if (product.productType === 'subscription') {
        await deliverSubscription(bot, telegramUserId, product, order)
      }

      // Mark item kama imetumwa
      await prisma.orderItem.updateMany({
        where: { orderId: order.id, productId: product.id },
        data: { isDelivered: true },
      })

      deliveredCount++
    } catch (err) {
      logger.error('Delivery failed for product', {
        productId: product.id,
        productName: product.name,
        orderId: order.id,
        error: err.message,
      })

      // Tuma ujumbe wa hitilafu kwa mtumiaji
      await bot.telegram.sendMessage(
        telegramUserId,
        `⚠️ Kumekuwa na tatizo kutuma *${escapeMarkdown(product.name)}*\\.\n` +
        `Tafadhali wasiliana na msaada: /support`,
        { parse_mode: 'MarkdownV2' }
      ).catch(() => {})
    }
  }

  // Weka order kama imetumwa
  if (deliveredCount === order.items.length) {
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'delivered', deliveredAt: new Date() },
    })
  }

  // Tuma muhtasari wa mwisho
  await bot.telegram.sendMessage(
    telegramUserId,
    `📦 *Utoaji Umekamilika\\!*\n\n` +
    `Bidhaa ${deliveredCount}/${order.items.length} zimetumwa kwa mafanikio\\.\n\n` +
    `Angalia manunuzi yako yote: /myorders\n` +
    `Tatizo lolote? /support`,
    { parse_mode: 'MarkdownV2' }
  ).catch(() => {})

  logger.info('Delivery completed', { orderId: order.id, deliveredCount })
}

// ─── File Delivery ────────────────────────────────────────────

/**
 * Tuma faili la bidhaa kwa mtumiaji
 */
async function deliverFile(bot, telegramUserId, product, order) {
  // Angalia kama filePath ni URL ya nje (Link)
  const isUrl = product.filePath && (product.filePath.startsWith('http://') || product.filePath.startsWith('https://'))

  if (isUrl) {
    const text = `📁 *${escapeMarkdown(product.name)}*\n\n` +
      `Bofya kiungo kifuatacho kupata au kupakua bidhaa yako:\n` +
      `🔗 [Pakua Hapa](${escapeMarkdown(product.filePath)})\n\n` +
      `_Order \\#${order.id}_`

    const msg = await bot.telegram.sendMessage(telegramUserId, text, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: false,
    })

    logger.info('File link delivered successfully', {
      productId: product.id,
      orderId: order.id,
    })
    return msg
  }

  // Kama faili tayari lina Telegram file_id, tumia hiyo (ni haraka zaidi)
  if (product.fileTelegramId) {
    const msg = await bot.telegram.sendDocument(telegramUserId, product.fileTelegramId, {
      caption: `📁 *${escapeMarkdown(product.name)}*\n\n_Order \\#${order.id}_`,
      parse_mode: 'MarkdownV2',
    })

    logger.info('File delivered via file_id', {
      productId: product.id,
      orderId: order.id,
    })
    return msg
  }

  // Tuma kutoka local storage
  if (product.filePath) {
    const fullPath = path.isAbsolute(product.filePath)
      ? product.filePath
      : path.join(config.storage.uploadDir, product.filePath)

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File haipo kwenye server: ${product.filePath}`)
    }

    const fileStream = fs.createReadStream(fullPath)
    const filename = product.fileOriginalName || path.basename(product.filePath)

    const msg = await bot.telegram.sendDocument(
      telegramUserId,
      { source: fileStream, filename },
      {
        caption: `📁 *${escapeMarkdown(product.name)}*\n\n_Order \\#${order.id}_`,
        parse_mode: 'MarkdownV2',
      }
    )

    // Cache file_id ya Telegram kwa matumizi ya baadaye
    if (msg.document?.file_id) {
      await prisma.product.update({
        where: { id: product.id },
        data: { fileTelegramId: msg.document.file_id },
      }).catch(() => {})
    }

    logger.info('File delivered from storage', { productId: product.id, orderId: order.id })
    return msg
  }

  throw new Error(`Bidhaa "${product.name}" haina faili`)
}

// ─── Text Content Delivery ────────────────────────────────────

/**
 * Tuma text content (na watermark) kwa mtumiaji
 */
async function deliverTextContent(bot, telegramUserId, product, order) {
  if (!product.lockedContent) {
    throw new Error(`Bidhaa "${product.name}" haina maudhui`)
  }

  // Ongeza watermark isiyoonekana
  const watermarkedContent = addWatermark(
    product.lockedContent,
    order.id,
    parseInt(String(telegramUserId))
  )

  // Header ya content
  await bot.telegram.sendMessage(
    telegramUserId,
    `🔓 *${escapeMarkdown(product.name)}* \\— Imefunguliwa\\!\n` +
    `━━━━━━━━━━━━━━━━━━━━`,
    { parse_mode: 'MarkdownV2' }
  )

  // Gawanya content kwa chunks kama ni ndefu sana
  const chunks = splitIntoChunks(watermarkedContent, CHUNK_SIZE)

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1

    try {
      if (product.contentFormat === 'markdown') {
        await bot.telegram.sendMessage(telegramUserId, chunks[i], {
          parse_mode: 'MarkdownV2',
        })
      } else {
        await bot.telegram.sendMessage(telegramUserId, chunks[i])
      }

      // Pumzika kidogo kati ya messages ili kuzuia rate limiting
      if (!isLast) await sleep(500)
    } catch (err) {
      // Kama markdown formatting imeshindwa, tuma kama plain text
      await bot.telegram.sendMessage(telegramUserId, chunks[i]).catch(() => {})
    }
  }

  // Footer
  await bot.telegram.sendMessage(
    telegramUserId,
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ Maudhui kamili yametumwa\\!\n` +
    `_Angalia tena baadaye: /myorders_`,
    { parse_mode: 'MarkdownV2' }
  )

  logger.info('Text content delivered', {
    productId: product.id,
    orderId: order.id,
    contentLength: product.lockedContent.length,
    chunks: chunks.length,
  })
}

// ─── Subscription Delivery ────────────────────────────────────

/**
 * Activate subscription kwa mtumiaji
 */
async function deliverSubscription(bot, telegramUserId, product, order) {
  const days = product.subscriptionDays || 30
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)

  // Pata user ID ya database
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramUserId) },
    select: { id: true },
  })

  if (!user) throw new Error('User haonekani kwenye database')

  // Unda au renew subscription
  await prisma.userSubscription.upsert({
    where: { userId_productId: { userId: user.id, productId: product.id } },
    update: { expiresAt, isActive: true, orderId: order.id },
    create: {
      userId: user.id,
      productId: product.id,
      orderId: order.id,
      expiresAt,
      isActive: true,
    },
  })

  await bot.telegram.sendMessage(
    telegramUserId,
    `🔄 *Usajili Umeanzishwa\\!*\n\n` +
    `📦 *${escapeMarkdown(product.name)}*\n` +
    `📅 Inaisha: *${escapeMarkdown(expiresAt.toLocaleDateString('sw-TZ'))}*\n\n` +
    `_Utapata taarifa siku 3 kabla ya kuisha\\._`,
    { parse_mode: 'MarkdownV2' }
  )

  logger.info('Subscription activated', {
    productId: product.id,
    userId: user.id,
    orderId: order.id,
    expiresAt,
  })
}

// ─── Re-delivery (kwa /myorders) ─────────────────────────────

/**
 * Tuma tena bidhaa iliyonunuliwa (kwa mtumiaji akiomba tena)
 * Rate limited - angalia rateLimit middleware
 */
async function redeliverProduct(bot, telegramUserId, orderId, productId) {
  // Thibitisha ownership
  const dbUser = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramUserId) },
    select: { id: true },
  })

  if (!dbUser) throw new Error('User haonekani')

  const orderItem = await prisma.orderItem.findFirst({
    where: {
      orderId,
      productId,
      order: {
        userId: dbUser.id,
        status: { in: ['paid', 'delivered'] },
      },
    },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          productType: true,
          filePath: true,
          fileTelegramId: true,
          fileOriginalName: true,
          lockedContent: true,
          contentFormat: true,
          subscriptionDays: true,
        },
      },
      order: { select: { id: true } },
    },
  })

  if (!orderItem) {
    throw new Error('Bidhaa hii haimo kwenye manunuzi yako')
  }

  const fakeOrder = { id: orderId }
  const product = orderItem.product

  if (product.productType === 'file') {
    await deliverFile(bot, telegramUserId, product, fakeOrder)
  } else if (product.productType === 'text_content') {
    await deliverTextContent(bot, telegramUserId, product, fakeOrder)
  } else {
    await bot.telegram.sendMessage(
      telegramUserId,
      '🔄 Usajili wako bado uko active. Angalia /myorders kwa maelezo.'
    )
  }

  logger.info('Re-delivery completed', { orderId, productId, telegramUserId })
}

// ─── Helpers ─────────────────────────────────────────────────

function splitIntoChunks(text, size) {
  const chunks = []
  let i = 0
  while (i < text.length) {
    // Jaribu kukata kwenye newline badala ya katikati ya neno
    let end = Math.min(i + size, text.length)
    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end)
      if (lastNewline > i) end = lastNewline + 1
    }
    chunks.push(text.slice(i, end))
    i = end
  }
  return chunks
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function escapeMarkdown(text) {
  return String(text || '').replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, '\\$1')
}

module.exports = {
  deliverOrder,
  deliverFile,
  deliverTextContent,
  deliverSubscription,
  redeliverProduct,
}
