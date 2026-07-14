'use strict'

const config = require('../config')

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

  const activeDiscount = isDiscountActive(product)
  const tzs = activeDiscount ? product.discountTzs : product.priceTzs
  const usd = activeDiscount ? product.discountUsd : product.priceUsd

  let text = `🤖 *${escapeMarkdown(name)}*\n\n`
  text += `📝 📋 *${lang === 'sw' ? 'Maelezo:' : 'Description:'}*\n\n`
  text += `${escapeMarkdown(desc)}\n`
  text += `━━━━━━━━━━━━━━━━━━━━\n`
  
  if (product.features && Array.isArray(product.features) && product.features.length > 0) {
    text += `✨ *${lang === 'sw' ? 'Utakachopata (Included)' : "What's Included"}*\n`
    for (const feat of product.features) {
      let formattedFeat = String(feat).trim()
      if (!formattedFeat.startsWith('✅') && !formattedFeat.startsWith('✔️') && !formattedFeat.startsWith('✔')) {
        formattedFeat = `✅ ${formattedFeat}`
      }
      text += `${escapeMarkdown(formattedFeat)}\n`
    }
    text += `━━━━━━━━━━━━━━━━━━━━\n`
  }

  // Format type
  const typeIcons = { file: '📁', text_content: '📄', subscription: '🔄' }
  const typeStr = formatProductType(product.productType, lang)
  
  text += `📦 *${lang === 'sw' ? 'Utapokea' : 'You Will Receive'}*\n`
  text += `${typeIcons[product.productType] || '📧'} ${escapeMarkdown(typeStr)}\n`
  text += `🚀 ${lang === 'sw' ? 'Inatumwa mara moja baada ya malipo' : 'Ready to Use After Activation'}\n`
  text += `━━━━━━━━━━━━━━━━━━━━\n`
  
  text += `🚀 *${lang === 'sw' ? 'Kuhusu Oda Yako' : 'Activation'}*\n`
  text += `_${escapeMarkdown(lang === 'sw' ? 'Oda yako inashughulikiwa mara moja unapolipa ili uipate bila kuchelewa.' : 'Your order is processed and activated immediately after purchase.')}_\n`
  text += `━━━━━━━━━━━━━━━━━━━━\n`

  text += `⚠️ *${lang === 'sw' ? 'Muhimu (Important)' : 'Important'}*\n`
  text += `• ${escapeMarkdown(lang === 'sw' ? 'Inatumwa kupitia Telegram' : 'Delivered via Telegram')}\n`
  text += `• ${escapeMarkdown(lang === 'sw' ? 'Msaada upo masaa 24' : '24/7 Support included')}\n\n`

  text += `🛡 *Warranty:* ${escapeMarkdown(lang === 'sw' ? 'Uhakika 100%' : '100% Guaranteed')}\n`
  text += `💵 *Price:* TZS ${tzs.toLocaleString('en-US')}\n`

  if (activeDiscount && product.discountEndsAt) {
    text += `⏳ *${lang === 'sw' ? 'Mwisho wa Punguzo:' : 'Discount Ends In:'}* ${escapeMarkdown(formatTimeRemaining(product.discountEndsAt, lang))}\n`
  }
  
  if (product.stock !== null) {
    text += `📦 *Stock:* ${product.stock}\n`
  }
  
  const sold = product.salesCount || 0
  text += `📈 *Sold:* ${sold}\n`

  if (product.recentSalesCount && product.recentSalesCount > 0) {
    text += `\n🔥 _${lang === 'sw' ? `Watu ${product.recentSalesCount} wamenunua bidhaa hii hivi karibuni!` : `${product.recentSalesCount} people bought this recently!`}_\n`
  } else if (sold > 10) {
    text += `\n🌟 _${lang === 'sw' ? `Bidhaa pendwa! Imenunuliwa mara ${sold}.` : `Popular item! Sold ${sold} times.`}_\n`
  }

  return text
}

/**
 * Format preview ya bidhaa ya text_content (bila locked_content)
 */
function formatTextProductPreview(product, lang = 'sw') {
  const name = lang === 'en' && product.nameEn ? product.nameEn : product.name
  const preview = product.previewDescription || product.description

  const activeDiscount = isDiscountActive(product)
  const tzs = activeDiscount ? product.discountTzs : product.priceTzs

  let text = `🤖 *${escapeMarkdown(name)}*\n\n`
  text += `📝 📋 *${lang === 'sw' ? 'Maelezo:' : 'Description:'}*\n\n`
  text += `${escapeMarkdown(preview)}\n`
  text += `━━━━━━━━━━━━━━━━━━━━\n`
  
  if (product.features && Array.isArray(product.features) && product.features.length > 0) {
    text += `✨ *${lang === 'sw' ? 'Utakachopata (Included)' : "What's Included"}*\n`
    for (const feat of product.features) {
      let formattedFeat = String(feat).trim()
      if (!formattedFeat.startsWith('✅') && !formattedFeat.startsWith('✔️') && !formattedFeat.startsWith('✔')) {
        formattedFeat = `✅ ${formattedFeat}`
      }
      text += `${escapeMarkdown(formattedFeat)}\n`
    }
    text += `━━━━━━━━━━━━━━━━━━━━\n`
  }

  text += `🔒 _${escapeMarkdown(lang === 'sw' ? 'Maudhui kamili yanafunguliwa baada ya malipo' : 'Full content unlocked after payment')}_\n\n`

  text += `💵 *Price:* TZS ${tzs.toLocaleString('en-US')}\n`

  if (activeDiscount && product.discountEndsAt) {
    text += `⏳ *${lang === 'sw' ? 'Mwisho wa Punguzo:' : 'Discount Ends In:'}* ${escapeMarkdown(formatTimeRemaining(product.discountEndsAt, lang))}\n`
  }

  const sold = product.salesCount || 0
  text += `📈 *Sold:* ${sold}\n`

  if (product.recentSalesCount && product.recentSalesCount > 0) {
    text += `\n🔥 _${lang === 'sw' ? `Watu ${product.recentSalesCount} wamenunua bidhaa hii hivi karibuni!` : `${product.recentSalesCount} people bought this recently!`}_\n`
  } else if (sold > 10) {
    text += `\n🌟 _${lang === 'sw' ? `Bidhaa pendwa! Imenunuliwa mara ${sold}.` : `Popular item! Sold ${sold} times.`}_\n`
  }

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
  text += `💰 TZS ${order.totalTzs.toLocaleString('en-US')}\n`
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

  let totalTzs = 0
  for (const item of cartItems) {
    const product = item.product
    const price = isDiscountActive(product) ? product.discountTzs : product.priceTzs
    totalTzs += price * item.quantity

    text += `• *${escapeMarkdown(product.name)}*\n`
    text += `  TZS ${price.toLocaleString('en-US')} × ${item.quantity} \\= TZS ${(price * item.quantity).toLocaleString('en-US')}\n`
  }

  text += `\n💰 *${lang === 'sw' ? 'Jumla' : 'Total'}:* TZS *${totalTzs.toLocaleString('en-US')}*`

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

/**
 * Piga hesabu ya muda uliobaki hadi kufika tarehe fulani (kwa ajili ya Flash Sales)
 */
function formatTimeRemaining(endDate, lang = 'sw') {
  const now = new Date()
  const end = new Date(endDate)
  const diff = end - now

  if (diff <= 0) return lang === 'sw' ? 'Muda umeisha' : 'Expired'

  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))

  const parts = []
  if (days > 0) parts.push(lang === 'sw' ? `${days} Siku` : `${days} Days`)
  if (hours > 0) parts.push(lang === 'sw' ? `${hours} Masaa` : `${hours} Hrs`)
  if (mins > 0 && days === 0) parts.push(lang === 'sw' ? `${mins} Dakika` : `${mins} Mins`)

  return parts.join(' na ') || (lang === 'sw' ? 'Chini ya dakika 1' : 'Less than 1 min')
}

// ─── Utility Helpers ─────────────────────────────────────────

/**
 * Angalia kama discount ya bidhaa iko active sasa hivi
 */
function isDiscountActive(product) {
  if (!product.discountTzs) return false
  const now = new Date()
  const start = product.discountStartsAt ? new Date(product.discountStartsAt) : null
  const end = product.discountEndsAt ? new Date(product.discountEndsAt) : null
  if (start && now < start) return false
  if (end && now > end) return false
  return true
}

/**
 * Pata jina la aina ya bidhaa kulingana na lugha
 * @param {string} type 
 * @param {string} lang 
 * @returns {string}
 */
function formatProductType(type, lang = 'sw') {
  if (lang === 'en') {
    if (type === 'file') return 'File Download'
    if (type === 'text_content') return 'Digital Text'
    if (type === 'subscription') return 'Subscription'
    if (type === 'bundle') return 'Bundle'
    return type
  }
  if (type === 'file') return 'Faili la Kupakua'
  if (type === 'text_content') return 'Maudhui ya Maandishi'
  if (type === 'subscription') return 'Usajili (Subscription)'
  if (type === 'bundle') return 'Kifurushi (Bundle)'
  return type
}

/**
 * Escape maalum herufi za MarkdownV2 za Telegram
 * @param {string} text
 * @returns {string}
 */
function escapeMarkdown(text) {
  if (!text) return ''
  // _ * [ ] ( ) ~ ` > # + - = | { } . !
  return String(text).replace(/([_*\[\]\(\)~`#\+\-\=|\{\}\.!])/g, '\\$1')
}

module.exports = {
  formatTzs,
  formatProductCard,
  formatProductType,
  formatTextProductPreview,
  formatOrderStatus,
  formatOrderSummary,
  formatCartSummary,
  formatDate,
  formatTimeRemaining,
  isDiscountActive,
  escapeMarkdown,
}
