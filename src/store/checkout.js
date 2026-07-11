'use strict'

const { Markup } = require('telegraf')
const { prisma } = require('../database')
const { escapeMarkdown, isDiscountActive } = require('../utils/formatting')
const { getUserCart, calculateCartTotal, createOrderFromCart, createDirectOrder, payOrderWithWallet } = require('../services/orderService')
const { getOrCreateWallet } = require('../services/walletService')
const { validateCoupon } = require('../services/referralService')
const { deliverOrder } = require('../services/deliveryService')
const { checkoutRateLimit } = require('../middlewares/rateLimit')
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
  const cartItems = await getUserCart(userId)

  if (cartItems.length === 0) {
    await ctx.reply(lang === 'sw' ? '🛒 Kikapu chako ni tupu.' : '🛒 Your cart is empty.')
    return
  }

  const wallet = await getOrCreateWallet(userId)
  const cartTotal = calculateCartTotal(cartItems)
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
    // 1. Unda order
    const order = await createOrderFromCart(userId, cartItems, couponId, couponDiscount)

    // 2. Lipia order kwa wallet (hukata salio, husasisha stock na log)
    const paidOrder = await payOrderWithWallet(userId, order.id)

    // 3. Tuma bidhaa mara moja
    await deliverOrder(ctx.telegram, ctx.from.id, paidOrder)

    // 4. Futa cart
    await prisma.cartItem.deleteMany({ where: { userId } }).catch(() => {})

    // Award commission ya referral (TZS)
    await awardReferralCommission(userId, paidOrder.totalTzs).catch(() => {})

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
  const product = await prisma.product.findUnique({
    where: { id: productId, isActive: true },
  })

  if (!product) {
    await ctx.reply(lang === 'sw' ? '❌ Bidhaa haipatikani.' : '❌ Product not available.')
    return
  }

  if (product.stock !== null && product.stock < 1) {
    await ctx.reply(lang === 'sw' ? '❌ Bidhaa hii imekwisha stock.' : '❌ Out of stock.')
    return
  }

  const wallet = await getOrCreateWallet(userId)
  const price = isDiscountActive(product) ? product.discountTzs : product.priceTzs
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
    // 1. Unda order
    const order = await createDirectOrder(userId, productId, couponId, couponDiscount)

    // 2. Lipia order kwa wallet
    const paidOrder = await payOrderWithWallet(userId, order.id)

    // 3. Tuma bidhaa mara moja
    await deliverOrder(ctx.telegram, ctx.from.id, paidOrder)

    // Award commission ya referral (TZS)
    await awardReferralCommission(userId, paidOrder.totalTzs).catch(() => {})

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
  const product = await prisma.product.findUnique({
    where: { id: productId, isActive: true },
  })

  if (!product) {
    await ctx.reply(lang === 'sw' ? '❌ Bidhaa haipatikani.' : '❌ Product not available.')
    return
  }

  const price = isDiscountActive(product) ? product.discountTzs : product.priceTzs
  ctx.session.userWizard = { scene: 'directBuy', step: 'confirm', data: { productId } }

  const text = lang === 'sw'
    ? `⚡ *Nunua Sasa — ${escapeMarkdown(product.name)}*\n\n💫 Bei: *TZS ${price.toLocaleString('en-US')}*\n\nJe, unataka kuendelea kulipia kupitia salio la Wallet yako?`
    : `⚡ *Buy Now — ${escapeMarkdown(product.name)}*\n\n💫 Price: *TZS ${price.toLocaleString('en-US')}*\n\nDo you want to proceed with paying from your Wallet balance?`

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
    select: { id: true },
  })
}

module.exports = {
  registerCheckoutHandlers,
  handleCheckoutWizard,
}
