'use strict'

const path = require('path')
const fs = require('fs')
const { prisma } = require('../database')
const { addWatermark } = require('../utils/watermark')
const { addPdfWatermark } = require('../utils/pdfWatermark')
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
    if (order.isGift) {
      // Hii ni zawadi, tunatengeneza link ya zawadi
      const crypto = require('crypto')
      const code = crypto.randomBytes(5).toString('hex').toUpperCase()

      await prisma.gift.create({
        data: {
          code,
          orderId: order.id,
          senderId: order.userId,
        }
      })

      const botUsername = bot.botInfo?.username || 'Bot'
      const link = `https://t.me/${botUsername}?start=gift_${code}`

      const { escapeMarkdown } = require('../utils/formatting')
      await bot.telegram.sendMessage(
        telegramUserId,
        `🎁 *Zawadi Iko Tayari\\!*\n\n` +
        `Umefanikiwa kununua oda \\#${order.id} kama zawadi\\. Tuma link ifuatayo kwa unayetaka kumpa:\n\n` +
        `👉 ${escapeMarkdown(link)}\n\n` +
        `_Akiminya link hii, atapokea bidhaa moja kwa moja kwenye Telegram yake\\._`,
        { parse_mode: 'MarkdownV2' }
      )

      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'delivered', deliveredAt: new Date() },
      })
      return // Usiendelee kutuma bidhaa
    }

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
      } else if (product.productType === 'bundle') {
        // Tuma bidhaa zote zilizomo kwenye bundle
        const bundledProducts = await prisma.product.findMany({
          where: { id: { in: product.bundledIds || [] } }
        })
        for (const bProduct of bundledProducts) {
          try {
            if (bProduct.productType === 'file') {
              await deliverFile(bot, telegramUserId, bProduct, order)
            } else if (bProduct.productType === 'text_content') {
              await deliverTextContent(bot, telegramUserId, bProduct, order)
            } else if (bProduct.productType === 'subscription') {
              await deliverSubscription(bot, telegramUserId, bProduct, order)
            }
          } catch (e) {
            logger.error('Failed to deliver bundled product', { bundleId: product.id, bundledProductId: bProduct.id, error: e.message })
          }
        }
      }

      // Mark item kama imetumwa
      await prisma.orderItem.updateMany({
        where: { orderId: order.id, productId: product.id },
        data: { 
          isDelivered: true,
          deliveryCount: { increment: 1 } 
        },
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

  logger.info('Delivery completed', { orderId: order.id, deliveredCount })
}

// ─── File Delivery ────────────────────────────────────────────

/**
 * Tuma faili la bidhaa kwa mtumiaji
 */
async function deliverFile(bot, telegramUserId, product, order) {
  // Angalia kama filePath ni URL ya nje (Link)
  const isUrl = product.filePath && (product.filePath.startsWith('http://') || product.filePath.startsWith('https://'))

  const { formatDate } = require('../utils/formatting')
  const dateStr = formatDate(order.createdAt)
  const escapeHTML = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  
  const receiptHeader = 
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 <b>ORDER ID:</b> #${order.id}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✅ <b>Status:</b> DELIVERED\n` +
    `🛒 <b>Product:</b> ${escapeHTML(product.name)}\n` +
    `💵 <b>Total:</b> TZS ${order.totalTzs.toLocaleString('en-US')}\n` +
    `💳 <b>Payment:</b> ${escapeHTML(order.paymentMethod)}\n` +
    `📅 <b>Date:</b> ${escapeHTML(dateStr)}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎁 <b>Your Product:</b>\n\n`

  if (isUrl) {
    const text = receiptHeader + `<a href="${product.filePath}">🔗 Bofya Hapa Kupakua (Click to Download)</a>`

    const msg = await bot.telegram.sendMessage(telegramUserId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      protect_content: true, // Zuia Forward/Screenshot
    })

    logger.info('File link delivered successfully', { productId: product.id, orderId: order.id })
    return msg
  }

  // Kama faili tayari lina Telegram file_id, tumia hiyo
  if (product.fileTelegramId) {
    // Bypass cache kama ni PDF ili kila mtu apate watermark yake
    if (!product.fileOriginalName?.toLowerCase().endsWith('.pdf') && !product.filePath?.toLowerCase().endsWith('.pdf')) {
      const msg = await bot.telegram.sendDocument(telegramUserId, product.fileTelegramId, {
        caption: receiptHeader + `<i>Faili lako limeambatishwa hapa chini.</i>`,
        parse_mode: 'HTML',
        protect_content: true,
      })

      logger.info('File delivered via file_id', { productId: product.id, orderId: order.id })
      return msg
    }
  }

  // Tuma kutoka local storage
  if (product.filePath) {
    const fullPath = path.isAbsolute(product.filePath)
      ? product.filePath
      : path.join(config.storage.uploadDir, product.filePath)

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File haipo kwenye server: ${product.filePath}`)
    }

    const isPdf = fullPath.toLowerCase().endsWith('.pdf')
    let fileToSend = fullPath
    let isTempFile = false

    if (isPdf) {
      const crypto = require('crypto')
      const tempFilename = `watermarked_${order.id}_${crypto.randomBytes(4).toString('hex')}.pdf`
      fileToSend = path.join(config.storage.uploadDir, tempFilename)
      await addPdfWatermark(fullPath, fileToSend, order)
      isTempFile = true
    }

    const fileStream = fs.createReadStream(fileToSend)
    const filename = product.fileOriginalName || path.basename(product.filePath)

    const msg = await bot.telegram.sendDocument(
      telegramUserId,
      { source: fileStream, filename },
      {
        caption: receiptHeader + `<i>Faili lako limeambatishwa hapa chini.</i>`,
        parse_mode: 'HTML',
        protect_content: true,
      }
    )

    // Cache file_id ya Telegram kwa matumizi ya baadaye (Kama sio PDF lenye watermark)
    if (msg.document?.file_id && !isPdf) {
      await prisma.product.update({
        where: { id: product.id },
        data: { fileTelegramId: msg.document.file_id },
      }).catch(() => {})
    }

    if (isTempFile) {
      fs.unlink(fileToSend, () => {})
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

  const { formatDate } = require('../utils/formatting')
  const dateStr = formatDate(order.createdAt)
  const escapeHTML = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const receiptHeader = 
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 <b>ORDER ID:</b> #${order.id}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✅ <b>Status:</b> DELIVERED\n` +
    `🛒 <b>Product:</b> ${escapeHTML(product.name)}\n` +
    `💵 <b>Total:</b> TZS ${order.totalTzs.toLocaleString('en-US')}\n` +
    `💳 <b>Payment:</b> ${escapeHTML(order.paymentMethod)}\n` +
    `📅 <b>Date:</b> ${escapeHTML(dateStr)}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎁 <b>Your Product:</b>\n\n`

  let fullMessage = receiptHeader
  if (product.contentFormat === 'html' || product.contentFormat === 'markdown') {
    // If it's code/credentials, we wrap it in <code> to match the user's request
    fullMessage += `<code>${escapeHTML(watermarkedContent)}</code>`
  } else {
    fullMessage += `<code>${escapeHTML(watermarkedContent)}</code>`
  }

  // Gawanya content kwa chunks kama ni ndefu sana
  // HTML tags make splitting harder, but for credentials it usually fits in 1 chunk.
  const chunks = splitIntoChunks(fullMessage, CHUNK_SIZE)

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1
    try {
      await bot.telegram.sendMessage(telegramUserId, chunks[i], {
        parse_mode: 'HTML',
        protect_content: true,
      })
      if (!isLast) await sleep(500)
    } catch (err) {
      await bot.telegram.sendMessage(telegramUserId, chunks[i], { protect_content: true }).catch(() => {})
    }
  }

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
          bundledIds: true,
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
  } else if (product.productType === 'bundle') {
    const bundledProducts = await prisma.product.findMany({
      where: { id: { in: product.bundledIds || [] } }
    })
    for (const bProduct of bundledProducts) {
      if (bProduct.productType === 'file') {
        await deliverFile(bot, telegramUserId, bProduct, fakeOrder)
      } else if (bProduct.productType === 'text_content') {
        await deliverTextContent(bot, telegramUserId, bProduct, fakeOrder)
      } else if (bProduct.productType === 'subscription') {
        await bot.telegram.sendMessage(telegramUserId, `🔄 Usajili: ${bProduct.name}`)
      }
    }
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
