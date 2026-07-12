'use strict'

const { Markup } = require('telegraf')
const {
  formatProductCard, formatTextProductPreview, escapeMarkdown,
  formatPagination, isDiscountActive, starsToTzs,
} = require('../utils/formatting')
const { getProductsPage, getProductPreview, getCategories, getBestSellers, getRecommendations } = require('../services/productService')
const { searchRateLimit } = require('../middlewares/rateLimit')
const logger = require('../utils/logger')

function registerBrowseHandlers(bot) {
  // ─── Browse Main (Categories) ────────────────────────────────
  bot.action(/^store:browse(:cat:(\d+))?(:page:(\d+))?$/, async (ctx) => {
    await ctx.answerCbQuery()
    const catId = ctx.match[2] ? parseInt(ctx.match[2]) : null
    const page = ctx.match[4] ? parseInt(ctx.match[4]) : 1
    const lang = ctx.session?.language || 'sw'

    if (!catId) {
      await showCategories(ctx, lang)
    } else {
      await showProductsInCategory(ctx, catId, page, lang)
    }
  })

  // ─── Category + Page shortcuts ────────────────────────────────
  bot.action(/^store:cat:(\d+):page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const catId = parseInt(ctx.match[1])
    const page = parseInt(ctx.match[2])
    const lang = ctx.session?.language || 'sw'
    await showProductsInCategory(ctx, catId, page, lang)
  })

  // ─── Product Detail ───────────────────────────────────────────
  bot.action(/^store:product:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'
    await showProductDetail(ctx, productId, lang)
  })

  // ─── Search ───────────────────────────────────────────────────
  bot.action('store:search', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'
    ctx.session.userWizard = { scene: 'search', step: 'query', data: {} }

    await ctx.editMessageText(
      lang === 'sw'
        ? '🔍 *Tafuta Bidhaa*\n\nAndika jina au maneno unayotafuta:'
        : '🔍 *Search Products*\n\nType a name or keywords:',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '◀️ Rudi' : '◀️ Back', 'store:menu')]]),
      }
    )
  })

  // ─── Featured Products ────────────────────────────────────────
  bot.action('store:featured', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'
    await showFeaturedProducts(ctx, lang)
  })

  // ─── Add to Wishlist ──────────────────────────────────────────
  bot.action(/^store:wish:add:(\d+)$/, async (ctx) => {
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'

    const user = await getDbUser(ctx.from.id)
    if (!user) return ctx.answerCbQuery('Hitilafu. Jaribu /start')

    try {
      await require('../database').prisma.wishlistItem.upsert({
        where: { userId_productId: { userId: user.id, productId } },
        update: {},
        create: { userId: user.id, productId },
      })
      await ctx.answerCbQuery(lang === 'sw' ? '❤️ Imeongezwa kwenye Vipendwa!' : '❤️ Added to Wishlist!')
    } catch {
      await ctx.answerCbQuery(lang === 'sw' ? 'Tayari ipo kwenye Vipendwa' : 'Already in Wishlist')
    }
  })

  // ─── Wishlist View ────────────────────────────────────────────
  bot.action('store:wishlist', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    const wishlist = await require('../database').prisma.wishlistItem.findMany({
      where: { userId: user.id },
      include: {
        product: { select: { id: true, name: true, priceTzs: true, discountTzs: true, discountEndsAt: true, isActive: true } }
      },
    })

    if (wishlist.length === 0) {
      const text = lang === 'sw'
        ? '❤️ *Vipendwa Vyako*\n\nHaujaweka bidhaa yoyote kwenye Vipendwa bado\\.'
        : '❤️ *Your Wishlist*\n\nYou haven\'t added any products to your Wishlist yet\\.'

      await ctx.editMessageText(text, {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '🛍️ Angalia Bidhaa' : '🛍️ Browse', 'store:browse')]]),
      })
      return
    }

    let text = lang === 'sw' ? `❤️ *Vipendwa Vyako \\(${wishlist.length}\\):*\n\n` : `❤️ *Your Wishlist \\(${wishlist.length}\\):*\n\n`

    const buttons = wishlist.map(item => {
      const p = item.product
      const price = isDiscountActive(p) ? p.discountTzs : p.priceTzs
      return [Markup.button.callback(`${p.name.substring(0, 22)} — TZS ${price.toLocaleString('en-US')}`, `store:product:${p.id}`)]
    })

    buttons.push([Markup.button.callback(lang === 'sw' ? '◀️ Rudi' : '◀️ Back', 'store:menu')])

    await ctx.editMessageText(text + wishlist.map(i => `• ${escapeMarkdown(i.product.name)}`).join('\n'), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard(buttons),
    })
  })

  // ─── Pre-Orders Router ────────────────────────────────────────
  bot.action('store:preorders', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'
    await showPreOrdersList(ctx, 1, lang)
  })

  bot.action(/^store:preorders:page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const page = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'
    await showPreOrdersList(ctx, page, lang)
  })
}

// ─── Search Handler ───────────────────────────────────────────

async function handleSearchQuery(ctx) {
  const wizard = ctx.session?.userWizard
  if (!wizard || wizard.scene !== 'search') return false

  const query = ctx.message?.text?.trim()
  if (!query || query.length < 2) {
    const lang = ctx.session?.language || 'sw'
    await ctx.reply(lang === 'sw' ? '⚠️ Andika maneno angalau 2 kutafuta.' : '⚠️ Type at least 2 characters to search.')
    return true
  }

  ctx.session.userWizard = null
  const lang = ctx.session?.language || 'sw'

  const result = await getProductsPage(1, { search: query })

  if (result.products.length === 0) {
    await ctx.reply(
      lang === 'sw'
        ? `🔍 Hakuna bidhaa iliyopatikana kwa "*${escapeMarkdown(query)}*"\\.\n\nJaribu maneno mengine\\.`
        : `🔍 No products found for "*${escapeMarkdown(query)}*"\\.\n\nTry different keywords\\.`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '🛍️ Angalia Zote' : '🛍️ Browse All', 'store:browse')]]),
      }
    )
    return true
  }

  const text = lang === 'sw'
    ? `🔍 *Matokeo kwa "${escapeMarkdown(query)}" \\(${result.total}\\):*\n`
    : `🔍 *Results for "${escapeMarkdown(query)}" \\(${result.total}\\):*\n`

  const buttons = result.products.map(p => {
    const price = isDiscountActive(p) ? p.discountTzs : p.priceTzs
    return [Markup.button.callback(`${p.name.substring(0, 22)} — TZS ${price.toLocaleString('en-US')}`, `store:product:${p.id}`)]
  })
  buttons.push([Markup.button.callback(lang === 'sw' ? '◀️ Rudi' : '◀️ Back', 'store:menu')])

  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard(buttons),
  })

  return true
}

// ─── Display Functions ────────────────────────────────────────

async function showCategories(ctx, lang = 'sw') {
  const categories = await getCategories()

  const title = lang === 'sw' ? '📂 *Chagua Category:*' : '📂 *Choose Category:*'

  if (categories.length === 0) {
    await ctx.editMessageText(
      title + '\n\n' + (lang === 'sw' ? '_Hakuna bidhaa bado_' : '_No products yet_'),
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '◀️ Rudi' : '◀️ Back', 'store:menu')]]),
      }
    )
    return
  }

  const catButtons = categories.map(c => [
    Markup.button.callback(
      `${c.name} (${c._count.products})`,
      `store:browse:cat:${c.id}`
    )
  ])

  // Bidhaa Maarufu
  catButtons.push([Markup.button.callback(lang === 'sw' ? '⭐ Bidhaa Maarufu' : '⭐ Featured', 'store:featured')])
  catButtons.push([Markup.button.callback(lang === 'sw' ? '◀️ Nyumbani' : '◀️ Home', 'store:menu')])

  await ctx.editMessageText(title, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard(catButtons),
  })
}

async function showProductsInCategory(ctx, catId, page, lang = 'sw') {
  const result = await getProductsPage(page, { categoryId: catId })
  const cat = await require('../database').prisma.category.findUnique({ where: { id: catId }, select: { name: true } })

  if (result.products.length === 0) {
    const msg = lang === 'sw'
      ? '📂 Hakuna bidhaa kwenye category hii bado\\.'
      : '📂 No products in this category yet\\.'

    await ctx.editMessageText(msg, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️', 'store:browse')]]),
    })
    return
  }

  // Onyesha bidhaa moja moja (siyo list)
  // Onyesha bidhaa ya kwanza kwenye ukurasa huu
  const product = result.products[0]
  const productIndex = (page - 1) * 5 // PRODUCTS_PER_PAGE

  // Kwa browse mode, tunatumia pagination ya bidhaa moja kwa wakati mmoja kwa UX bora
  await showSingleProductInBrowse(ctx, product, {
    currentIndex: productIndex + 1,
    total: result.total,
    catId,
    page,
    allProducts: result.products,
    lang,
    catName: cat?.name || '',
  })
}

async function showSingleProductInBrowse(ctx, product, meta) {
  const { lang, currentIndex, total, catId, allProducts } = meta

  // Format card
  const text = product.productType === 'text_content'
    ? formatTextProductPreview(product, lang)
    : formatProductCard(product, lang)

  const activeDiscount = isDiscountActive(product)
  const tzs = activeDiscount ? product.discountTzs : product.priceTzs
  const usd = activeDiscount ? product.discountUsd : product.priceUsd

  const priceLabel = activeDiscount
    ? `💰 TZS ${tzs.toLocaleString('en-US')} [🔥 ${lang === 'sw' ? 'PUNGUZO' : 'DISCOUNT'}]`
    : `💰 TZS ${tzs.toLocaleString('en-US')} (approx. $${usd.toFixed(2)})`

  const buyBtnLabel = product.isPreOrder
    ? '🔜 Pre-Order'
    : (lang === 'sw' ? '⚡ Nunua Sasa' : '⚡ Buy Now')

  const productButtons = [
    [
      Markup.button.callback(priceLabel, `store:buy:${product.id}`)
    ],
    [
      Markup.button.callback(
        lang === 'sw' ? '🛒 Ongeza Kikapuni' : '🛒 Add to Cart',
        `store:cart:add:${product.id}`
      ),
      Markup.button.callback(
        buyBtnLabel,
        `store:buy:${product.id}`
      ),
    ],
    [
      Markup.button.callback('❤️', `store:wish:add:${product.id}`),
      Markup.button.callback(
        `${currentIndex}/${total}`,
        'noop' // Hii ni display tu, siyo button halisi
      ),
      Markup.button.callback('⭐ Reviews', `store:reviews:${product.id}`),
    ],
  ]

  // Navigation kati ya bidhaa kwenye category
  const navButtons = []

  // Pata index kwenye current page
  const indexInPage = allProducts.findIndex(p => p.id === product.id)

  if (indexInPage > 0) {
    navButtons.push(Markup.button.callback('◀️ Iliyopita', `store:prod_nav:${catId}:${currentIndex - 2}`))
  } else if (meta.page > 1) {
    navButtons.push(Markup.button.callback('◀️', `store:cat:${catId}:page:${meta.page - 1}`))
  }

  if (indexInPage < allProducts.length - 1) {
    navButtons.push(Markup.button.callback('Inayofuata ▶️', `store:prod_nav:${catId}:${currentIndex}`))
  } else if (meta.hasNext) {
    navButtons.push(Markup.button.callback('▶️', `store:cat:${catId}:page:${meta.page + 1}`))
  }

  if (navButtons.length) productButtons.push(navButtons)
  productButtons.push([Markup.button.callback(lang === 'sw' ? '📂 Categories' : '📂 Categories', 'store:browse')])

  const keyboard = Markup.inlineKeyboard(productButtons)

  try {
    if (product.thumbnailFileId && !ctx.callbackQuery?.message?.photo) {
      // Tuma picha na caption
      await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
    } else {
      await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
    }
  } catch (err) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
  }
}

async function showProductDetail(ctx, productId, lang = 'sw') {
  const product = await getProductPreview(productId)

  if (!product) {
    await ctx.editMessageText(
      lang === 'sw' ? '❌ Bidhaa haipatikani au imezimwa.' : '❌ Product not found or unavailable.',
      Markup.inlineKeyboard([[Markup.button.callback('◀️', 'store:browse')]])
    )
    return
  }

  const stars = isDiscountActive(product) ? product.discountStars : product.priceStars

  const activeDiscount = isDiscountActive(product)
  const tzs = activeDiscount ? product.discountTzs : product.priceTzs
  const usd = activeDiscount ? product.discountUsd : product.priceUsd

  const priceLabel = activeDiscount
    ? `💰 TZS ${tzs.toLocaleString('en-US')} [🔥 ${lang === 'sw' ? 'PUNGUZO' : 'DISCOUNT'}]`
    : `💰 TZS ${tzs.toLocaleString('en-US')} (approx. $${usd.toFixed(2)})`

  const text = product.productType === 'text_content'
    ? formatTextProductPreview(product, lang)
    : formatProductCard(product, lang)

  // Reviews summary
  let reviewText = ''
  if (product._count.reviews > 0 && product.reviews?.length > 0) {
    const avgRating = product.reviews.reduce((s, r) => s + r.rating, 0) / product.reviews.length
    reviewText = `\n⭐ ${avgRating.toFixed(1)}/5 \\(${product._count.reviews} reviews\\)`
  }

  let buyLabel = lang === 'sw' ? '⚡ Nunua Sasa' : '⚡ Buy Now'
  if (product.isPreOrder) {
    buyLabel = '🔜 Pre-Order'
  } else if (product.productType === 'text_content') {
    buyLabel = lang === 'sw' ? '🔓 Nunua Kufungua' : '🔓 Buy to Unlock'
  }

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(priceLabel, `store:buy:${productId}`)
    ],
    [
      Markup.button.callback(lang === 'sw' ? '🛒 Ongeza Kikapuni' : '🛒 Add to Cart', `store:cart:add:${productId}`),
      Markup.button.callback(buyLabel, `store:buy:${productId}`),
    ],
    [
      Markup.button.callback(lang === 'sw' ? '❤️ Vipendwa' : '❤️ Wishlist', `store:wish:add:${productId}`),
      Markup.button.callback('⭐ Reviews', `store:reviews:${productId}`),
    ],
    [Markup.button.callback(lang === 'sw' ? '◀️ Rudi' : '◀️ Back', 'store:browse')],
  ])

  await ctx.editMessageText(text + reviewText, { parse_mode: 'MarkdownV2', ...keyboard })
}

async function showFeaturedProducts(ctx, lang = 'sw') {
  const result = await getProductsPage(1, { isFeatured: true })

  if (result.products.length === 0) {
    await ctx.editMessageText(
      lang === 'sw' ? '⭐ Hakuna bidhaa maarufu kwa sasa.' : '⭐ No featured products currently.',
      Markup.inlineKeyboard([[Markup.button.callback('◀️', 'store:browse')]])
    )
    return
  }

  const title = lang === 'sw' ? `⭐ *Bidhaa Maarufu \\(${result.total}\\):*` : `⭐ *Featured Products \\(${result.total}\\):*`

  const buttons = result.products.map(p => {
    const price = isDiscountActive(p) ? p.discountTzs : p.priceTzs
    return [Markup.button.callback(`${p.name.substring(0, 22)} — TZS ${price.toLocaleString('en-US')}`, `store:product:${p.id}`)]
  })
  buttons.push([Markup.button.callback('◀️', 'store:browse')])

  await ctx.editMessageText(title, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) })
}

// ─── Reviews View ─────────────────────────────────────────────

async function registerReviewHandlers(bot) {
  bot.action(/^store:reviews:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'

    const reviews = await require('../database').prisma.review.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { user: { select: { fullName: true, username: true } } },
    })

    if (reviews.length === 0) {
      await ctx.editMessageText(
        lang === 'sw' ? '⭐ Hakuna reviews bado kwa bidhaa hii.' : '⭐ No reviews yet for this product.',
        Markup.inlineKeyboard([[Markup.button.callback('◀️', `store:product:${productId}`)]])
      )
      return
    }

    let text = lang === 'sw' ? '⭐ *Reviews:*\n\n' : '⭐ *Reviews:*\n\n'
    for (const r of reviews) {
      const name = r.user.username ? `@${r.user.username}` : r.user.fullName || 'Anonymous'
      const stars = '⭐'.repeat(r.rating) + '☆'.repeat(5 - r.rating)
      text += `${stars} — ${escapeMarkdown(name)}\n`
      if (r.comment) text += `_${escapeMarkdown(r.comment)}_\n`
      text += '\n'
    }

    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️', `store:product:${productId}`)]]),
    })
  })
}

// ─── Helpers ─────────────────────────────────────────────────

async function getDbUser(telegramId) {
  return require('../database').prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true },
  })
}

module.exports = {
  registerBrowseHandlers,
  handleSearchQuery,
  registerReviewHandlers,
}

async function showPreOrdersList(ctx, page = 1, lang = 'sw') {
  const result = await getProductsPage(page, { isPreOrder: true })

  if (result.products.length === 0) {
    const text = lang === 'sw'
      ? '🔜 *Hakuna Oda za Mapema \\(Pre\\-Orders\\) kwa sasa\\.*'
      : '🔜 *No Pre\\-Orders available at this time\\.*'
    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '◀️ Nyumbani' : '◀️ Home', 'store:menu')]])
    })
    return
  }

  const title = lang === 'sw'
    ? `🔜 *Oda za Mapema \\(Pre\\-Orders\\) \\(${result.total}\\):*`
    : `🔜 *Pre\\-Orders Available \\(${result.total}\\):*`

  const buttons = result.products.map(p => {
    const price = isDiscountActive(p) ? p.discountTzs : p.priceTzs
    return [Markup.button.callback(`${p.name.substring(0, 22)} — TZS ${price.toLocaleString('en-US')}`, `store:product:${p.id}`)]
  })

  // Pagination row
  const nav = []
  if (result.hasPrev) nav.push(Markup.button.callback('◀️', `store:preorders:page:${page - 1}`))
  if (result.hasNext) nav.push(Markup.button.callback('▶️', `store:preorders:page:${page + 1}`))
  if (nav.length) buttons.push(nav)

  buttons.push([Markup.button.callback(lang === 'sw' ? '◀️ Rudi Nyumbani' : '◀️ Back Home', 'store:menu')])

  await ctx.editMessageText(title, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard(buttons),
  })
}
