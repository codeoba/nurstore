'use strict'

const { Markup } = require('telegraf')
const { prisma } = require('../database')
const { formatCartSummary, escapeMarkdown, isDiscountActive } = require('../utils/formatting')
const { getUserCart, calculateCartTotal } = require('../services/orderService')
const logger = require('../utils/logger')

function registerCartHandlers(bot) {
  // ─── View Cart ────────────────────────────────────────────────
  bot.action('store:cart', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    await showCart(ctx, user.id, lang)
  })

  // ─── Add to Cart ──────────────────────────────────────────────
  bot.action(/^store:cart:add:(\d+)$/, async (ctx) => {
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return ctx.answerCbQuery('Hitilafu. Jaribu /start')

    // Angalia kama bidhaa ipo
    const product = await prisma.product.findUnique({
      where: { id: productId, isActive: true },
      select: { id: true, name: true, stock: true },
    })

    if (!product) {
      await ctx.answerCbQuery(
        lang === 'sw' ? '❌ Bidhaa hii haipo tena.' : '❌ This product is no longer available.',
        { show_alert: true }
      )
      return
    }

    try {
      await prisma.cartItem.upsert({
        where: { userId_productId: { userId: user.id, productId } },
        update: { quantity: { increment: 1 } },
        create: { userId: user.id, productId, quantity: 1 },
      })

      // Angalia kama haijapita stock
      if (product.stock !== null) {
        const cartItem = await prisma.cartItem.findUnique({
          where: { userId_productId: { userId: user.id, productId } },
        })
        if (cartItem && cartItem.quantity > product.stock) {
          await prisma.cartItem.update({
            where: { userId_productId: { userId: user.id, productId } },
            data: { quantity: product.stock },
          })
          await ctx.answerCbQuery(
            lang === 'sw' ? `⚠️ Stock imepungua! Imeongezwa ${product.stock}.` : `⚠️ Limited stock! Added ${product.stock}.`,
            { show_alert: true }
          )
          return
        }
      }

      await ctx.answerCbQuery(
        lang === 'sw' ? `✅ "${product.name.substring(0, 20)}" imeongezwa kikapuni!` : `✅ Added to cart!`
      )
    } catch (err) {
      logger.error('Add to cart error', { error: err.message })
      await ctx.answerCbQuery(lang === 'sw' ? '❌ Hitilafu. Jaribu tena.' : '❌ Error. Try again.')
    }
  })

  // ─── Remove from Cart ─────────────────────────────────────────
  bot.action(/^store:cart:remove:(\d+)$/, async (ctx) => {
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    await prisma.cartItem.deleteMany({
      where: { userId: user.id, productId },
    })

    await ctx.answerCbQuery(lang === 'sw' ? '🗑️ Imeondolewa kutoka kikapuni' : '🗑️ Removed from cart')
    await showCart(ctx, user.id, lang)
  })

  // ─── Decrease Quantity ────────────────────────────────────────
  bot.action(/^store:cart:decrease:(\d+)$/, async (ctx) => {
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    const cartItem = await prisma.cartItem.findUnique({
      where: { userId_productId: { userId: user.id, productId } },
    })

    if (!cartItem) return ctx.answerCbQuery()

    if (cartItem.quantity <= 1) {
      await prisma.cartItem.delete({ where: { userId_productId: { userId: user.id, productId } } })
    } else {
      await prisma.cartItem.update({
        where: { userId_productId: { userId: user.id, productId } },
        data: { quantity: { decrement: 1 } },
      })
    }

    await ctx.answerCbQuery()
    await showCart(ctx, user.id, lang)
  })

  // ─── Clear Cart ───────────────────────────────────────────────
  bot.action('store:cart:clear', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    await ctx.editMessageText(
      lang === 'sw'
        ? '⚠️ *Una uhakika unataka kufuta bidhaa zote kutoka kikapuni?*'
        : '⚠️ *Are you sure you want to clear your cart?*',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(lang === 'sw' ? '✅ Ndiyo, Futa Yote' : '✅ Yes, Clear All', 'store:cart:clear:confirm'),
            Markup.button.callback(lang === 'sw' ? '❌ Hapana' : '❌ No', 'store:cart'),
          ],
        ]),
      }
    )
  })

  bot.action('store:cart:clear:confirm', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    await prisma.cartItem.deleteMany({ where: { userId: user.id } })
    await ctx.editMessageText(
      lang === 'sw' ? '✅ Kikapu kimefutwa.' : '✅ Cart cleared.',
      Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '🛍️ Angalia Bidhaa' : '🛍️ Browse', 'store:browse')]])
    )
  })

  // ─── Proceed to Checkout ───────────────────────────────────────
  bot.action('store:cart:checkout', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    const cartItems = await getUserCart(user.id)
    if (cartItems.length === 0) {
      await ctx.answerCbQuery(lang === 'sw' ? '🛒 Kikapu chako ni tupu.' : '🛒 Your cart is empty.', { show_alert: true })
      return
    }

    // Hamia checkout
    ctx.session.userWizard = { scene: 'checkout', step: 'coupon', data: { userId: user.id } }

    const total = calculateCartTotal(cartItems)

    const text = lang === 'sw'
      ? `💳 *Malipo — Muhtasari*\n\n${formatCartSummary(cartItems, lang)}\n\nUna coupon code?`
      : `💳 *Checkout Summary*\n\n${formatCartSummary(cartItems, lang)}\n\nDo you have a coupon code?`

    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(lang === 'sw' ? '🎟️ Ingiza Coupon' : '🎟️ Enter Coupon', 'store:checkout:coupon')],
        [Markup.button.callback(lang === 'sw' ? '⚡ Endelea bila Coupon' : '⚡ Continue without Coupon', 'store:checkout:pay')],
        [Markup.button.callback(lang === 'sw' ? '◀️ Rudi Kikapuni' : '◀️ Back to Cart', 'store:cart')],
      ]),
    })
  })
}

// ─── Display Functions ────────────────────────────────────────

async function showCart(ctx, userId, lang = 'sw') {
  const cartItems = await getUserCart(userId)

  if (cartItems.length === 0) {
    const text = lang === 'sw'
      ? '🛒 *Kikapu Chako ni Tupu*\n\nHaujaweka bidhaa yoyote kikapuni bado\\.'
      : '🛒 *Your Cart is Empty*\n\nYou haven\'t added any products to your cart yet\\.'

    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(lang === 'sw' ? '🛍️ Angalia Bidhaa' : '🛍️ Browse Products', 'store:browse')],
        [Markup.button.callback(lang === 'sw' ? '◀️ Rudi' : '◀️ Back', 'store:menu')],
      ]),
    })
    return
  }

  const text = formatCartSummary(cartItems, lang)

  // Buttons za kila item
  const itemButtons = cartItems.map(item => {
    const p = item.product
    return [
      Markup.button.callback(`➖`, `store:cart:decrease:${p.id}`),
      Markup.button.callback(`${p.name.substring(0, 20)} (${item.quantity})`, `store:product:${p.id}`),
      Markup.button.callback(`🗑️`, `store:cart:remove:${p.id}`),
    ]
  })

  itemButtons.push([
    Markup.button.callback(lang === 'sw' ? '🗑️ Futa Yote' : '🗑️ Clear All', 'store:cart:clear'),
    Markup.button.callback(lang === 'sw' ? '💳 Lipia Sasa' : '💳 Checkout', 'store:cart:checkout'),
  ])
  itemButtons.push([Markup.button.callback(lang === 'sw' ? '🛍️ Ongeza Zaidi' : '🛍️ Add More', 'store:browse')])

  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(itemButtons) })
}

// ─── Helpers ─────────────────────────────────────────────────

async function getDbUser(telegramId) {
  return prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true },
  })
}

module.exports = { registerCartHandlers, showCart }
