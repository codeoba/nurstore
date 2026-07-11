'use strict'

const config = require('../config')

// ─── Stars <-> TZS Conversion ───────────────────────────────

/**
 * Badilisha Stars kuwa TZS kwa display
 * @param {number} stars
 * @returns {string} e.g. "3,200 TZS"
 */
function starsToTzs(stars) {
  const tzs = stars * config.currency.tzsSPerStar
  return formatTzs(tzs)
}

/**
 * Format TZS na comma separators
 * @param {number} amount
 * @returns {string}
 */
function formatTzs(amount) {
  return `${amount.toLocaleString('en-US')} TZS`
}

// ─── Product Formatting ──────────────────────────────────────

/**
 * Format kadi ya bidhaa moja kwa mtumiaji
 * @param {object} product - Prisma Product object
 * @param {string} lang - "sw" au "en"
 * @returns {string} Telegram markdown text
 */
function formatProductCard(product, lang = 'sw') {
  const name = lang === 'en' && product.nameEn ? product.nameEn : product.name
  const desc = lang === 'en' && product.descriptionEn ? product.descriptionEn : product.description

  // Bei halisi (angalia discount)
  const activeDiscount = isDiscountActive(product)
  const stars = activeDiscount ? product.discountStars : product.priceStars

  let text = `*${escapeMarkdown(name)}*\n\n`
  text += `${escapeMarkdown(desc)}\n\n`

  // Features (kwa text_content bidhaa)
  if (product.features && Array.isArray(product.features) && product.features.length > 0) {
    text += `*${lang === 'sw' ? 'Utakachopata' : 'What You Get'}:*\n`
    for (const feat of product.features) {
      text += `${escapeMarkdown(feat)}\n`
    }
    text += '\n'
  }

  // Bei
  if (activeDiscount) {
    text += `💰 *Bei:* ~~⭐ ${product.priceStars}~~ ⭐ *${stars}* \\(${starsToTzs(stars)}\\)\n`
    text += `🔥 *Punguzo!*\n`
  } else {
    text += `💰 *Bei:* ⭐ *${stars}* \\(${starsToTzs(stars)}\\)\n`
  }

  // Aina ya bidhaa
  const typeIcons = { file: '📁', text_content: '📄', subscription: '🔄' }
  text += `📦 *Aina:* ${typeIcons[product.productType] || '📦'} ${formatProductType(product.productType, lang)}\n`

  // Stock
  if (product.stock !== null) {
    text += `📊 *Iliyobaki:* ${product.stock} ${lang === 'sw' ? 'tu' : 'remaining'}\n`
  }

  return text
}

/**
 * Format aina ya bidhaa
 */
function formatProductType(type, lang = 'sw') {
  const types = {
    file: { sw: 'Faili la Download', en: 'Downloadable File' },
    text_content: { sw: 'Maudhui ya Maandishi', en: 'Text Content' },
    subscription: { sw: 'Usajili wa Mara kwa Mara', en: 'Subscription' },
  }
  return types[type]?.[lang] || type
}

/**
 * Format preview ya bidhaa ya text_content (bila locked_content)
 */
function formatTextProductPreview(product, lang = 'sw') {
  const name = lang === 'en' && product.nameEn ? product.nameEn : product.name
  const preview = product.previewDescription || product.description

  let text = `📄 *${escapeMarkdown(name)}*\n\n`
  text += `${escapeMarkdown(preview)}\n\n`

  if (product.features && Array.isArray(product.features) && product.features.length > 0) {
    text += `*${lang === 'sw' ? '✅ Utakachopata' : '✅ What You Get'}:*\n`
    for (const feat of product.features) {
      text += `${escapeMarkdown(String(feat))}\n`
    }
    text += '\n'
  }

  const stars = isDiscountActive(product) ? product.discountStars : product.priceStars
  text += `\n💰 *Bei:* ⭐ *${stars}* \\(${starsToTzs(stars)}\\)\n`
  text += `\n🔒 _${lang === 'sw' ? 'Maudhui kamili yanafunguliwa baada ya malipo' : 'Full content unlocked after payment'}_`

  return text
}

// ─── Order Formatting ────────────────────────────────────────

/**
 * Format hali ya order kwa emoji
 */
function formatOrderStatus(status, lang = 'sw') {
  const statuses = {
    pending:   { emoji: '⏳', sw: 'Inasubiri Malipo',  en: 'Awaiting Payment' },
    paid:      { emoji: '✅', sw: 'Imelipwa',           en: 'Paid' },
    delivered: { emoji: '📬', sw: 'Imetumwa',           en: 'Delivered' },
    failed:    { emoji: '❌', sw: 'Imeshindwa',         en: 'Failed' },
    refunded:  { emoji: '↩️', sw: 'Imerudishwa',        en: 'Refunded' },
    cancelled: { emoji: '🚫', sw: 'Imefutwa',           en: 'Cancelled' },
  }
  const s = statuses[status] || { emoji: '❓', sw: status, en: status }
  return `${s.emoji} ${lang === 'sw' ? s.sw : s.en}`
}

/**
 * Format muhtasari wa order moja
 */
function formatOrderSummary(order, lang = 'sw') {
  const date = new Date(order.createdAt).toLocaleDateString('sw-TZ', {
    year: 'numeric', month: 'short', day: 'numeric'
  })
  const status = formatOrderStatus(order.status, lang)
  const items = order.items?.length || 0

  let text = `📋 *Order \\#${order.id}*\n`
  text += `📅 ${escapeMarkdown(date)}\n`
  text += `📦 ${items} ${lang === 'sw' ? 'bidhaa' : 'item(s)'}\n`
  text += `💫 ⭐ ${order.totalStars} ${lang === 'sw' ? 'Stars' : 'Stars'}\n`
  text += `📊 ${status}\n`

  return text
}

/**
 * Format muhtasari wa cart
 */
function formatCartSummary(cartItems, lang = 'sw') {
  if (!cartItems || cartItems.length === 0) {
    return lang === 'sw'
      ? '🛒 Kikapu chako ni tupu\\.'
      : '🛒 Your cart is empty\\.'
  }

  let text = lang === 'sw'
    ? `🛒 *Kikapu Chako \\(${cartItems.length} bidhaa\\)*\n\n`
    : `🛒 *Your Cart \\(${cartItems.length} items\\)*\n\n`

  let totalStars = 0
  for (const item of cartItems) {
    const product = item.product
    const stars = isDiscountActive(product) ? product.discountStars : product.priceStars
    totalStars += stars * item.quantity

    text += `• *${escapeMarkdown(product.name)}*\n`
    text += `  ⭐ ${stars} × ${item.quantity} \\= ⭐ ${stars * item.quantity}\n`
  }

  text += `\n💰 *${lang === 'sw' ? 'Jumla' : 'Total'}:* ⭐ *${totalStars}* \\(${starsToTzs(totalStars)}\\)`

  return text
}

// ─── Date Formatting ─────────────────────────────────────────

/**
 * Format tarehe kwa Kiswahili/English
 */
function formatDate(date, lang = 'sw') {
  return new Date(date).toLocaleDateString(
    lang === 'sw' ? 'sw-TZ' : 'en-US',
    { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  )
}

// ─── Utility Helpers ─────────────────────────────────────────

/**
 * Angalia kama discount ya bidhaa iko active sasa hivi
 */
function isDiscountActive(product) {
  if (!product.discountStars) return false
  const now = new Date()
  const start = product.discountStartsAt ? new Date(product.discountStartsAt) : null
  const end = product.discountEndsAt ? new Date(product.discountEndsAt) : null
  if (start && now < start) return false
  if (end && now > end) return false
  return true
}

/**
 * Escape special characters kwa Telegram MarkdownV2
 */
function escapeMarkdown(text) {
  if (!text) return ''
  return String(text).replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, '\\$1')
}

/**
 * Punguza maandishi kama ni marefu sana
 */
function truncate(text, maxLength = 100) {
  if (!text) return ''
  return text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text
}

/**
 * Format nambari nzuri ya pagination
 */
function formatPagination(page, totalPages, lang = 'sw') {
  return lang === 'sw'
    ? `📄 Ukurasa ${page} kati ya ${totalPages}`
    : `📄 Page ${page} of ${totalPages}`
}

/**
 * Stars display yenye emoji
 */
function starsDisplay(amount) {
  return `⭐ ${amount}`
}

/**
 * Format rating kwa nyota
 */
function formatRating(rating) {
  const stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating)
  return stars
}

module.exports = {
  starsToTzs,
  formatTzs,
  formatProductCard,
  formatProductType,
  formatTextProductPreview,
  formatOrderStatus,
  formatOrderSummary,
  formatCartSummary,
  formatDate,
  isDiscountActive,
  escapeMarkdown,
  truncate,
  formatPagination,
  starsDisplay,
  formatRating,
}
