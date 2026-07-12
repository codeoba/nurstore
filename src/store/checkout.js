'use strict'

const { Markup } = require('telegraf')
const { prisma } = require('../database')
const { escapeMarkdown, isDiscountActive } = require('../utils/formatting')
const { getUserCart, calculateCartTotal, createOrderFromCart, createDirectOrder, payOrderWithWallet } = require('../services/orderService')
const { getOrCreateWallet } = require('../services/walletService')
const { validateCoupon } = require('../services/referralService')
const { deliverOrder } = require('../services/deliveryService')
const { checkoutRateLimit } = require('../middlewares/rateLimit')
const config = require('../config')
const logger = require('../utils/logger')

function registerCheckoutHandlers(bot) {
  // ─── Buy Now (Direct Purchase Initiator) ──────────────────────
  bot.action(/^store:buy:(\d+)$/, checkoutRateLimit, async (ctx) => {
    await ctx.answerCbQuery()
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    await initDirectCheckout(ctx, user.id, productId, lang)
  })

  // ─── Coupon Input ─────────────────────────────────────────────
  bot.action('store:checkout:coupon', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'

    if (!ctx.session.userWizard) {
      ctx.session.userWizard = { scene: 'checkout', step: 'coupon_input', data: {} }
    } else {
      ctx.session.userWizard.step = 'coupon_input'
    }

    await ctx.editMessageText(
      lang === 'sw'
        ? '🎟️ *Ingiza Coupon Code:*\n\n_Mfano: SAVE20_'
        : '🎟️ *Enter Coupon Code:*\n\n_Example: SAVE20_',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(
          lang === 'sw' ? '❌ Ruka Coupon' : '❌ Skip Coupon',
          'store:checkout:pay'
        )]]),
      }
    )
  })

  // ─── Proceed to Pay (Cart Checkout) ───────────────────────────
  bot.action('store:checkout:pay', checkoutRateLimit, async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    const wizard = ctx.session.userWizard
    const couponId = wizard?.data?.couponId || null
    const couponDiscount = wizard?.data?.couponDiscount || 0

    await processCartWalletCheckout(ctx, user.id, couponId, couponDiscount, lang)
    ctx.session.userWizard = null
  })

  // ─── Direct Buy Confirm (Wallet checkout for single product) ──
  bot.action(/^store:buy_confirm:(\d+)$/, checkoutRateLimit, async (ctx) => {
    await ctx.answerCbQuery()
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    const wizard = ctx.session.userWizard
    const couponId = wizard?.data?.couponId || null
    const couponDiscount = wizard?.data?.couponDiscount || 0

    await processDirectWalletCheckout(ctx, user.id, productId, couponId, couponDiscount, lang)
    ctx.session.userWizard = null
  })

  // ─── Coupon for Direct Buy ────────────────────────────────────
  bot.action(/^store:buy:coupon:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'

    ctx.session.userWizard = {
      scene: 'directBuyCoupon',
      step: 'coupon_input',
      data: { productId },
    }

    await ctx.editMessageText(
      lang === 'sw' ? '🎟️ Ingiza coupon code:' : '🎟️ Enter coupon code:',
      Markup.inlineKeyboard([[Markup.button.callback(
        lang === 'sw' ? '❌ Ruka' : '❌ Skip',
        `store:buy_confirm:${productId}`
      )]])
    )
  })
}

// ─── Checkout Processors ──────────────────────────────────────

/**
 * Shughulikia ununuzi wa Cart kwa Wallet
 */
async function processCartWalletCheckout(ctx, userId, couponId, couponDiscount, lang) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isVip: true },
  })

  const isVip = user?.isVip || false
  const cartItems = await getUserCart(userId)

  if (cartItems.length === 0) {
    await ctx.reply(lang === 'sw' ? '🛒 Kikapu chako ni tupu.' : '🛒 Your cart is empty.')
    return
  }

  // Angalia bidhaa za VIP pekee
  const hasVipOnlyProduct = cartItems.some(item => item.product.isVipOnly)
  if (hasVipOnlyProduct && !isVip) {
    const text = lang === 'sw'
      ? `👑 *Maudhui Maalum ya VIP\\!*\n\n` +
        `Kikapu chako kina bidhaa inayohitaji uanachama wa *VIP*\\. Tafadhali jiunge na VIP kwanza kupitia Wasifu wako ili kuagiza bidhaa hii\\.`
      : `👑 *VIP Exclusive Content\\!*\n\n` +
        `Your cart contains a VIP-only product\\. Please join VIP first in your Profile to purchase this item\\.`

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(lang === 'sw' ? '👑 Jiunge na VIP' : '👑 Join VIP', 'store:vip:join_init')],
      [Markup.button.callback(lang === 'sw' ? '🛒 Rudi kwenye Kikapu' : '🛒 Back to Cart', 'store:cart')],
    ])

    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
    return
  }

  const wallet = await getOrCreateWallet(userId)
  const cartTotal = calculateCartTotal(cartItems, isVip)
  const finalTotal = Math.max(cartTotal - couponDiscount, 100)

  if (wallet.balance < finalTotal) {
    const text = lang === 'sw'
      ? `❌ *Salio Lako Halitoshi\\!*\n\n` +
        `💸 Bei ya Order: *TZS ${finalTotal.toLocaleString('en-US')}*\n` +
        `💳 Salio la Wallet: *TZS ${wallet.balance.toLocaleString('en-US')}*\n\n` +
        `Tafadhali ongeza salio kwenye Wallet yako kwanza ili kukamilisha ununuzi\\.`
      : `❌ *Insufficient Balance\\!*\n\n` +
        `💸 Order Price: *TZS ${finalTotal.toLocaleString('en-US')}*\n` +
        `💳 Wallet Balance: *TZS ${wallet.balance.toLocaleString('en-US')}*\n\n` +
        `Please top up your Wallet first to complete this purchase\\.`

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(lang === 'sw' ? '➕ Weka Salio (Top Up)' : '➕ Top Up Balance', 'store:wallet:deposit_init')],
      [Markup.button.callback(lang === 'sw' ? '🛒 Rudi kwenye Kikapu' : '🛒 Back to Cart', 'store:cart')],
    ])

    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
    return
  }

  // Mtumiaji ana salio la kutosha!
  try {
    // 1. Unda order (kupitisha isVip kupiga hesabu)
    const order = await createOrderFromCart(userId, cartItems, couponId, couponDiscount, isVip)

    // 2. Lipia order kwa wallet (hukata salio, husasisha stock na log)
    const paidOrder = await payOrderWithWallet(userId, order.id)

    // Futa cart
    await prisma.cartItem.deleteMany({ where: { userId } }).catch(() => {})

    // Award commission ya referral (TZS)
    await awardReferralCommission(userId, paidOrder.totalTzs).catch(() => {})

    if (paidOrder.status === 'pre_ordered') {
      await ctx.reply(
        lang === 'sw'
          ? `🎉 *Oda ya Mapema (Pre-Order) Imekamilika\\!*\n\n` +
            `Kiasi kilichokatwa: *TZS ${finalTotal.toLocaleString('en-US')}*\n` +
            `Umeagiza mapema: *${escapeMarkdown(paidOrder.items.map(i => i.product.name).join(', '))}*\\.\n\n` +
            `Bidhaa hii itatumwa hapa kiotomatiki pindi itakapowekwa LIVE na Admin\\! Shukrani\\.`
          : `🎉 *Pre-Order Completed\\!*\n\n` +
            `Amount deducted: *TZS ${finalTotal.toLocaleString('en-US')}*\n` +
            `You have pre-ordered: *${escapeMarkdown(paidOrder.items.map(i => i.product.name).join(', '))}*\\.\n\n` +
            `This content will be delivered here automatically once released by the Admin\\! Thank you\\.`,
        {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '📦 Maagizo Yangu' : '📦 My Orders', 'store:orders')]]),
        }
      )
      return
    }

    // 3. Tuma bidhaa mara moja
    await deliverOrder(ctx.telegram, ctx.from.id, paidOrder)

    await ctx.reply(
      lang === 'sw'
        ? `🎉 *Ununuzi Umekamilika\\!*\n\n` +
          `Kiasi kilichokatwa: *TZS ${finalTotal.toLocaleString('en-US')}*\n` +
          `Bidhaa zako zimetumwa moja kwa moja kwenye chat hii\\. Asante kwa kufanya biashara nasi\\!`
        : `🎉 *Purchase Completed\\!*\n\n` +
          `Amount deducted: *TZS ${finalTotal.toLocaleString('en-US')}*\n` +
          `Your items have been delivered directly in this chat\\. Thank you for shopping with us\\!`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '📦 Maagizo Yangu' : '📦 My Orders', 'store:orders')]]),
      }
    )
  } catch (err) {
    logger.error('Wallet cart checkout failed', { error: err.message, userId })
    await ctx.reply(lang === 'sw' ? `❌ Hitilafu ya kiufundi: ${err.message}` : `❌ Transaction failed: ${err.message}`)
  }
}

/**
 * Shughulikia ununuzi wa bidhaa moja (Buy Now) kwa Wallet
 */
async function processDirectWalletCheckout(ctx, userId, productId, couponId, couponDiscount, lang) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isVip: true },
  })

  const isVip = user?.isVip || false

  const product = await prisma.product.findUnique({
    where: { id: productId, isActive: true },
  })

  if (!product) {
    await ctx.reply(lang === 'sw' ? '❌ Bidhaa haipatikani.' : '❌ Product not available.')
    return
  }

  // Angalia kama mteja anajaribu kununua bidhaa ya VIP tu bila kuwa VIP
  if (product.isVipOnly && !isVip) {
    const text = lang === 'sw'
      ? `👑 *Bidhaa Maalum ya VIP\\!*\n\n` +
        `Bidhaa hii inapatikana kwa wanachama wa *VIP* tu\\. Tafadhali jiunge na VIP kwanza kuweza kununua\\.`
      : `👑 *VIP Exclusive Product\\!*\n\n` +
        `This product is only available for *VIP* members\\. Please join VIP first to purchase\\.`

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(lang === 'sw' ? '👑 Jiunge na VIP' : '👑 Join VIP', 'store:vip:join_init')],
      [Markup.button.callback(lang === 'sw' ? '◀️ Rudi kwenye Bidhaa' : '◀️ Back to Product', `store:product:${productId}`)],
    ])

    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
    return
  }

  const wallet = await getOrCreateWallet(userId)
  let price = isDiscountActive(product) ? product.discountTzs : product.priceTzs
  if (isVip) {
    const vipDiscount = config.vip?.discountPercent || 15
    price = Math.round(price * (1 - vipDiscount / 100))
  }

  const finalTotal = Math.max(price - couponDiscount, 100)

  if (wallet.balance < finalTotal) {
    const text = lang === 'sw'
      ? `❌ *Salio Lako Halitoshi\\!*\n\n` +
        `💸 Bei ya Bidhaa: *TZS ${finalTotal.toLocaleString('en-US')}*\n` +
        `💳 Salio la Wallet: *TZS ${wallet.balance.toLocaleString('en-US')}*\n\n` +
        `Tafadhali ongeza salio kwenye Wallet yako kwanza ili kununua bidhaa hii\\.`
      : `❌ *Insufficient Balance\\!*\n\n` +
        `💸 Product Price: *TZS ${finalTotal.toLocaleString('en-US')}*\n` +
        `💳 Wallet Balance: *TZS ${wallet.balance.toLocaleString('en-US')}*\n\n` +
        `Please top up your Wallet first to buy this product\\.`

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(lang === 'sw' ? '➕ Weka Salio (Top Up)' : '➕ Top Up Balance', 'store:wallet:deposit_init')],
      [Markup.button.callback(lang === 'sw' ? '◀️ Rudi kwenye Bidhaa' : '◀️ Back to Product', `store:product:${productId}`)],
    ])

    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
    return
  }

  // Mtumiaji ana hela
  try {
    // 1. Unda order (kupitisha isVip)
    const order = await createDirectOrder(userId, productId, couponId, couponDiscount, isVip)

    // 2. Lipia order kwa wallet
    const paidOrder = await payOrderWithWallet(userId, order.id)

    // Award commission ya referral (TZS)
    await awardReferralCommission(userId, paidOrder.totalTzs).catch(() => {})

    if (paidOrder.status === 'pre_ordered') {
      await ctx.reply(
        lang === 'sw'
          ? `🎉 *Oda ya Mapema (Pre-Order) Imekamilika\\!*\n\n` +
            `Kiasi kilichokatwa: *TZS ${finalTotal.toLocaleString('en-US')}*\n` +
            `Umeagiza mapema: *${escapeMarkdown(product.name)}*\\.\n\n` +
            `Bidhaa hii itatumwa hapa kiotomatiki pindi itakapowekwa LIVE na Admin\\! Shukrani\\.`
          : `🎉 *Pre-Order Completed\\!*\n\n` +
            `Amount deducted: *TZS ${finalTotal.toLocaleString('en-US')}*\n` +
            `You have pre-ordered: *${escapeMarkdown(product.name)}*\\.\n\n` +
            `This content will be delivered here automatically once released by the Admin\\! Thank you\\.`,
        {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '📦 Maagizo Yangu' : '📦 My Orders', 'store:orders')]]),
        }
      )
      return
    }

    // 3. Tuma bidhaa mara moja
    await deliverOrder(ctx.telegram, ctx.from.id, paidOrder)

    await ctx.reply(
      lang === 'sw'
        ? `🎉 *Ununuzi Umekamilika\\!*\n\n` +
          `Bidhaa: *${escapeMarkdown(product.name)}*\n` +
          `Kiasi kilichokatwa: *TZS ${finalTotal.toLocaleString('en-US')}*\n\n` +
          `Bidhaa yako imetumwa moja kwa moja kwenye chat hii\\.`
        : `🎉 *Purchase Completed\\!*\n\n` +
          `Product: *${escapeMarkdown(product.name)}*\n` +
          `Amount deducted: *TZS ${finalTotal.toLocaleString('en-US')}*\n\n` +
          `Your product has been delivered directly in this chat\\.`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '📦 Maagizo Yangu' : '📦 My Orders', 'store:orders')]]),
      }
    )
  } catch (err) {
    logger.error('Wallet direct checkout failed', { error: err.message, userId, productId })
    await ctx.reply(lang === 'sw' ? `❌ Hitilafu ya kiufundi: ${err.message}` : `❌ Transaction failed: ${err.message}`)
  }
}

// ─── Direct Buy Flow Initiator ────────────────────────────────

async function initDirectCheckout(ctx, userId, productId, lang) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isVip: true },
  })

  const isVip = user?.isVip || false

  const product = await prisma.product.findUnique({
    where: { id: productId, isActive: true },
  })

  if (!product) {
    await ctx.reply(lang === 'sw' ? '❌ Bidhaa haipatikani.' : '❌ Product not available.')
    return
  }

  // Angalia bidhaa za VIP pekee
  if (product.isVipOnly && !isVip) {
    const text = lang === 'sw'
      ? `👑 *Maudhui Maalum ya VIP\\!*\n\n` +
        `Bidhaa hii inapatikana kwa wanachama wa *VIP* pekee\\. Jiunge na VIP ili kupata punguzo na bidhaa hizi\\.`
      : `👑 *VIP Exclusive Content\\!*\n\n` +
        `This product is only available for *VIP* members\\. Please join VIP to proceed\\.`

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(lang === 'sw' ? '👑 Jiunge na VIP' : '👑 Join VIP', 'store:vip:join_init')],
      [Markup.button.callback(lang === 'sw' ? '◀️ Rudi kwenye Bidhaa' : '◀️ Back to Product', `store:product:${productId}`)],
    ])

    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
    return
  }

  let price = isDiscountActive(product) ? product.discountTzs : product.priceTzs
  let vipText = ''

  if (isVip) {
    const originalPrice = price
    const vipDiscount = config.vip?.discountPercent || 15
    price = Math.round(price * (1 - vipDiscount / 100))
    vipText = lang === 'sw'
      ? `\n👑 *VIP Discount Applied \\(${vipDiscount}%\\):* ~~TZS ${originalPrice.toLocaleString('en-US')}~~ TZS *${price.toLocaleString('en-US')}*`
      : `\n👑 *VIP Discount Applied \\(${vipDiscount}%\\):* ~~TZS ${originalPrice.toLocaleString('en-US')}~~ TZS *${price.toLocaleString('en-US')}*`
  }

  ctx.session.userWizard = { scene: 'directBuy', step: 'confirm', data: { productId } }

  const text = lang === 'sw'
    ? `⚡ *Nunua Sasa — ${escapeMarkdown(product.name)}*\n\nBei: *TZS ${price.toLocaleString('en-US')}*${escapeMarkdown(vipText)}\n\nJe, unataka kuendelea kulipia kupitia salio la Wallet yako?`
    : `⚡ *Buy Now — ${escapeMarkdown(product.name)}*\n\nPrice: *TZS ${price.toLocaleString('en-US')}*${escapeMarkdown(vipText)}\n\nDo you want to proceed with paying from your Wallet balance?`

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(lang === 'sw' ? '🎟️ Tumia Coupon' : '🎟️ Use Coupon', `store:buy:coupon:${productId}`),
        Markup.button.callback(lang === 'sw' ? '⚡ Thibitisha Ununuzi' : '⚡ Confirm Purchase', `store:buy_confirm:${productId}`),
      ],
      [Markup.button.callback(lang === 'sw' ? '❌ Ghairi' : '❌ Cancel', `store:product:${productId}`)],
    ]),
  })
}

// ─── Checkout Wizard Handler ──────────────────────────────────

async function handleCheckoutWizard(ctx) {
  const wizard = ctx.session?.userWizard
  if (!wizard) return false
  if (!['checkout', 'directBuyCoupon'].includes(wizard.scene)) return false
  if (wizard.step !== 'coupon_input') return false

  const code = ctx.message?.text?.trim().toUpperCase()
  const lang = ctx.session?.language || 'sw'

  if (!code) {
    await ctx.reply(lang === 'sw' ? '⚠️ Ingiza code ya coupon.' : '⚠️ Enter a coupon code.')
    return true
  }

  let orderTotalTzs = 0
  const user = await getDbUser(ctx.from.id)
  if (!user) return true

  if (wizard.scene === 'checkout') {
    const cartItems = await getUserCart(user.id)
    orderTotalTzs = calculateCartTotal(cartItems)
  } else if (wizard.scene === 'directBuyCoupon') {
    const product = await prisma.product.findUnique({
      where: { id: wizard.data.productId },
    })
    orderTotalTzs = isDiscountActive(product) ? product.discountTzs : product.priceTzs
  }

  const couponResult = await validateCoupon(code, orderTotalTzs)

  if (!couponResult.valid) {
    await ctx.reply(
      lang === 'sw'
        ? `❌ ${couponResult.error}`
        : `❌ ${couponResult.error}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(lang === 'sw' ? '🔄 Jaribu Tena' : '🔄 Try Again', 'store:checkout:coupon')],
        [Markup.button.callback(lang === 'sw' ? '❌ Ruka' : '❌ Skip', wizard.scene === 'checkout' ? 'store:checkout:pay' : `store:buy_confirm:${wizard.data.productId}`)],
      ])
    )
    return true
  }

  // Coupon ni sahihi!
  wizard.data.couponId = couponResult.couponId
  wizard.data.couponDiscount = couponResult.discount

  const successMsg = lang === 'sw'
    ? `✅ *Coupon \`${code}\` Imetumika\\!*` +
      `\nPunguzo: *TZS ${couponResult.discount.toLocaleString('en-US')}*` +
      `\nJumla mpya: *TZS ${Math.max(orderTotalTzs - couponResult.discount, 100).toLocaleString('en-US')}*`
    : `✅ *Coupon \`${code}\` Applied\\!*` +
      `\nDiscount: *TZS ${couponResult.discount.toLocaleString('en-US')}*` +
      `\nNew Total: *TZS ${Math.max(orderTotalTzs - couponResult.discount, 100).toLocaleString('en-US')}*`

  wizard.step = 'coupon_confirmed'

  await ctx.reply(successMsg, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([[
      Markup.button.callback(
        lang === 'sw' ? '⚡ Endelea Kulipia' : '⚡ Proceed to Pay',
        wizard.scene === 'checkout' ? 'store:checkout:pay' : `store:buy_confirm:${wizard.data.productId}`
      ),
    ]]),
  })

  return true
}

// ─── Helpers ─────────────────────────────────────────────────

async function getDbUser(telegramId) {
  return prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true, isVip: true },
  })
}

module.exports = {
  registerCheckoutHandlers,
  handleCheckoutWizard,
}
