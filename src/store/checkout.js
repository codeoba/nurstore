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

  // ─── Mobile Money Network Selection ───────────────────────────
  bot.action(/^store:buy:mobilemoney:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'
    await showMobileMoneyNetworks(ctx, productId, lang)
  })

  // ─── Mobile Money Network Chosen (show instructions) ────────────────
  bot.action(/^store:buy:mm:(mpesa|airtel|mix|halopesa):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const network = ctx.match[1]
    const productId = parseInt(ctx.match[2])
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return
    await showMobileMoneyInstructions(ctx, user.id, productId, network, lang)
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

  const wallet = await getOrCreateWallet(userId)

  const text = lang === 'sw'
    ? `⚡ *Nunua Sasa — ${escapeMarkdown(product.name)}*\n\nBei: *TZS ${price.toLocaleString('en-US')}*${escapeMarkdown(vipText)}\n\nChagua njia ya malipo:`
    : `⚡ *Buy Now — ${escapeMarkdown(product.name)}*\n\nPrice: *TZS ${price.toLocaleString('en-US')}*${escapeMarkdown(vipText)}\n\nChoose payment method:`

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(
          lang === 'sw'
            ? `💳 Wallet (TZS ${wallet.balance.toLocaleString('en-US')})`
            : `💳 Wallet (TZS ${wallet.balance.toLocaleString('en-US')})`,
          `store:buy_confirm:${productId}`
        ),
      ],
      [
        Markup.button.callback(
          lang === 'sw' ? '📱 Lipia kwa Mobile Money' : '📱 Pay via Mobile Money',
          `store:buy:mobilemoney:${productId}`
        ),
      ],
      [
        Markup.button.callback(lang === 'sw' ? '🎟️ Tumia Coupon' : '🎟️ Use Coupon', `store:buy:coupon:${productId}`),
        Markup.button.callback(lang === 'sw' ? '❌ Ghairi' : '❌ Cancel', `store:product:${productId}`),
      ],
    ]),
  })
}

// ─── Checkout Wizard Handler ──────────────────────────────────

async function handleCheckoutWizard(ctx) {
  const wizard = ctx.session?.userWizard
  if (!wizard) return false

  const lang = ctx.session?.language || 'sw'

  // ─── Mobile Money Screenshot Handler ───────────────────────
  if (wizard.scene === 'mobilemoney_proof' && wizard.step === 'screenshot') {
    const { orderId, productId, network, priceTzs } = wizard.data

    // Accept picha au hati/document
    const photo = ctx.message?.photo
    const document = ctx.message?.document

    if (!photo && !document) {
      await ctx.reply(
        lang === 'sw'
          ? '⚠️ Tafadhali tuma *picha (screenshot)* ya muamala wako, si maandishi.'
          : '⚠️ Please send a *screenshot image* of your transaction, not text.',
        { parse_mode: 'MarkdownV2' }
      )
      return true
    }

    ctx.session.userWizard = null

    // Notify admins with screenshot + approve/reject buttons
    const clientName = ctx.from.username
      ? `@${ctx.from.username}`
      : ctx.from.first_name || String(ctx.from.id)

    const networkNames = { mpesa: 'M-Pesa', airtel: 'Airtel Money', mix: 'Mix by Yas', halopesa: 'HaloPesa' }
    const networkLabel = networkNames[network] || network

    const caption =
      `📱 *Ombi la Malipo ya Mobile Money\\!*\n\n` +
      `👤 Mteja: ${escapeMarkdown(clientName)} \\(ID: \`${ctx.from.id}\`\\)\n` +
      `💰 Kiasi: TZS *${priceTzs.toLocaleString('en-US')}*\n` +
      `⚙️ Mtandao: *${escapeMarkdown(networkLabel)}*\n` +
      `📦 Order ID: *\\#${orderId}*\n\n` +
      `_Hakikisha Transaction ID kwenye screenshot kabla ya kuidhinisha\._`

    const { notifyAdmins } = require('../services/notificationService')
    const inlineKeyboard = {
      inline_keyboard: [[
        { text: '✅ Kubali na Tuma Bidhaa', callback_data: `admin:mobilemoney:approve:${orderId}` },
        { text: '❌ Kataa', callback_data: `admin:mobilemoney:reject:${orderId}` },
      ]]
    }

    if (photo) {
      // Tuma picha kwa kila admin
      const fileId = photo[photo.length - 1].file_id
      for (const adminId of require('../config').admin.ids) {
        await ctx.telegram.sendPhoto(adminId, fileId, {
          caption,
          parse_mode: 'MarkdownV2',
          reply_markup: inlineKeyboard
        }).catch(() => {})
      }
    } else {
      // Tuma document kwa kila admin
      for (const adminId of require('../config').admin.ids) {
        await ctx.telegram.sendDocument(adminId, document.file_id, {
          caption,
          parse_mode: 'MarkdownV2',
          reply_markup: inlineKeyboard
        }).catch(() => {})
      }
    }

    // Inform customer
    await ctx.reply(
      lang === 'sw'
        ? `✅ *Screenshot Imepokelewa\\!*\n\nAsante\\! Malipo yako yanakaguliwa na wasimamizi\\. Utapokea bidhaa yako hapa mara malipo yatakapothibitishwa\\. Kwa kawaida inachukua dakika chache\\!`
        : `✅ *Screenshot Received\\!*\n\nThank you\\! Your payment is being verified by our team\\. You will receive your product here as soon as it is confirmed\\. This usually takes a few minutes\\!`,
      { parse_mode: 'MarkdownV2' }
    )
    return true
  }

  // ─── Coupon Input Handler (original) ───────────────────────────────
  if (!['checkout', 'directBuyCoupon'].includes(wizard.scene)) return false
  if (wizard.step !== 'coupon_input') return false

  const code = ctx.message?.text?.trim().toUpperCase()

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

// ─── Mobile Money Helpers ─────────────────────────────────────

async function showMobileMoneyNetworks(ctx, productId, lang) {
  const mm = config.payments?.mobileMoney || {}
  const buttons = []

  if (mm.mpesa)    buttons.push([Markup.button.callback('🔴 M-Pesa',       `store:buy:mm:mpesa:${productId}`)])
  if (mm.airtel)   buttons.push([Markup.button.callback('🔵 Airtel Money', `store:buy:mm:airtel:${productId}`)])
  if (mm.mix)      buttons.push([Markup.button.callback('🟡 Mix by Yas',   `store:buy:mm:mix:${productId}`)])
  if (mm.halopesa) buttons.push([Markup.button.callback('🟢 HaloPesa',     `store:buy:mm:halopesa:${productId}`)])

  if (buttons.length === 0) {
    await ctx.answerCbQuery(
      lang === 'sw' ? '⚠️ Malipo ya Mobile Money hayapatikani kwa sasa.' : '⚠️ Mobile Money not configured yet.',
      { show_alert: true }
    )
    return
  }

  buttons.push([Markup.button.callback(lang === 'sw' ? '◀️ Rudi Nyuma' : '◀️ Back', `store:buy:${productId}`)])

  const text = lang === 'sw'
    ? `📱 *Chagua Mtandao wa Kulipia*\n\nTafadhali chagua mtandao utakaotumia kufanya malipo:`
    : `📱 *Choose Mobile Money Network*\n\nPlease select the network you will use to pay:`

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard(buttons)
  }).catch(() => {})
}

async function showMobileMoneyInstructions(ctx, userId, productId, network, lang) {
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

  let price = isDiscountActive(product) ? product.discountTzs : product.priceTzs
  if (isVip) {
    const vipDiscount = config.vip?.discountPercent || 15
    price = Math.round(price * (1 - vipDiscount / 100))
  }

  const mm = config.payments?.mobileMoney || {}
  const number = mm[network]
  if (!number) {
    await ctx.answerCbQuery(lang === 'sw' ? '❌ Mtandao huu haujasanidiwa.' : '❌ This network is not configured.', { show_alert: true })
    return
  }

  const networkNames = { mpesa: 'M-Pesa', airtel: 'Airtel Money', mix: 'Mix by Yas', halopesa: 'HaloPesa' }
  const networkName = networkNames[network] || network

  // Create order
  const order = await createDirectOrder(userId, productId, null, 0, isVip)

  ctx.session.userWizard = {
    scene: 'mobilemoney_proof',
    step: 'screenshot',
    data: { orderId: order.id, productId, network, priceTzs: price }
  }

  const ownerName = mm.name || 'Duka'

  const text = lang === 'sw'
    ? `📱 *Lipia kwa ${networkName}*\n\n` +
      `Tafadhali fuata hatua zifuatazo kukamilisha ununuzi wa *${escapeMarkdown(product.name)}*:\n\n` +
      `1️⃣ Tuma kiasi cha *TZS ${price.toLocaleString('en-US')}* kwenda namba hii:\n` +
      `📞 Namba: \`${escapeMarkdown(number)}\`\n` +
      `👤 Jina: *${escapeMarkdown(ownerName)}*\n\n` +
      `2️⃣ Baada ya kutuma, piga *screenshot* (picha) ya muamala ukionyesha umefanikiwa\\.\n\n` +
      `3️⃣ Tuma picha hiyo hapa (reply kwenye chat hii) ili tuhakiki na kukutumia bidhaa yako\\.\n\n` +
      `_Tunasubiri picha yako\\.\\.\\._`
    : `📱 *Pay via ${networkName}*\n\n` +
      `Please follow these steps to complete your purchase of *${escapeMarkdown(product.name)}*:\n\n` +
      `1️⃣ Send exactly *TZS ${price.toLocaleString('en-US')}* to this number:\n` +
      `📞 Number: \`${escapeMarkdown(number)}\`\n` +
      `👤 Name: *${escapeMarkdown(ownerName)}*\n\n` +
      `2️⃣ Take a *screenshot* of the successful transaction\\.\n\n` +
      `3️⃣ Send the screenshot here in this chat so we can verify and deliver your product\\.\n\n` +
      `_Waiting for your screenshot\\.\\.\\._`

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(lang === 'sw' ? '❌ Ghairi' : '❌ Cancel', `store:product:${productId}`)]
    ])
  })
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
