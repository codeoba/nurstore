'use strict'

const { Markup } = require('telegraf')
const path = require('path')
const fs = require('fs')
const { isAdmin, auditLog } = require('../middlewares/auth')
const { escapeMarkdown, isDiscountActive } = require('../utils/formatting')
const {
  adminGetProducts, createProduct, updateProduct, deleteProduct,
  setProductDiscount, getCategories, createCategory, PRODUCTS_PER_PAGE,
} = require('../services/productService')
const { sanitizeText, isAllowedFileType, parseNumber } = require('../utils/validation')
const config = require('../config')
const logger = require('../utils/logger')

const WIZARD = 'addProduct'
const EDIT_WIZARD = 'editProduct'
const CAT_WIZARD = 'addCategory'

/**
 * Register admin product management handlers
 * @param {import('telegraf').Telegraf} bot
 */
function registerAdminProductHandlers(bot) {
  // ─── Products List ──────────────────────────────────────────
  bot.action(/^admin:products(:page:(\d+))?$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const page = parseInt(ctx.match[2] || '1')
    await showProductsList(ctx, page)
  })

  // ─── Add Product Wizard ────────────────────────────────────
  bot.action('admin:product:add', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    ctx.session.adminWizard = { scene: WIZARD, step: 'type', data: {} }

    await ctx.editMessageText(
      '📦 *Ongeza Bidhaa Mpya*\n\nChagua aina ya bidhaa:',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📁 Faili', 'admin:prod:type:file'),
            Markup.button.callback('📄 Maandishi', 'admin:prod:type:text_content'),
          ],
          [
            Markup.button.callback('🔄 Usajili', 'admin:prod:type:subscription'),
            Markup.button.callback('📦 Kifurushi (Bundle)', 'admin:prod:type:bundle'),
          ],
          [Markup.button.callback('❌ Ghairi', 'admin:products')],
        ]),
      }
    )
  })

  // Type selection
  bot.action(/^admin:prod:type:(file|text_content|subscription|bundle)$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const type = ctx.match[1]
    ctx.session.adminWizard = { scene: WIZARD, step: 'name', data: { productType: type } }

    const typeNames = { file: '📁 Faili', text_content: '📄 Maandishi', subscription: '🔄 Usajili', bundle: '📦 Kifurushi' }
    await ctx.editMessageText(
      `📦 *Bidhaa Mpya — ${typeNames[type]}*\n\n` +
      `*Hatua 1/7:* Andika *jina* la bidhaa:`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Ghairi', 'admin:products')]]),
      }
    )
  })

  // View single product (admin)
  bot.action(/^admin:prod:view:(\d+)$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const productId = parseInt(ctx.match[1])
    await showProductDetail(ctx, productId)
  })

  // Toggle product active/inactive
  bot.action(/^admin:prod:toggle:(\d+)$/, isAdmin, async (ctx) => {
    const productId = parseInt(ctx.match[1])
    const product = await require('../database').prisma.product.findUnique({
      where: { id: productId },
      select: { isActive: true, name: true },
    })

    if (!product) {
      await ctx.answerCbQuery('Bidhaa haipatikani', { show_alert: true })
      return
    }

    await updateProduct(productId, { isActive: !product.isActive })
    await auditLog(ctx.from.id, 'product.toggled', { productId, isActive: !product.isActive })
    await ctx.answerCbQuery(product.isActive ? '❌ Bidhaa imezimwa' : '✅ Bidhaa imewashwa')
    await showProductDetail(ctx, productId)
  })

  // Toggle featured
  bot.action(/^admin:prod:feature:(\d+)$/, isAdmin, async (ctx) => {
    const productId = parseInt(ctx.match[1])
    const product = await require('../database').prisma.product.findUnique({
      where: { id: productId },
      select: { isFeatured: true },
    })
    await updateProduct(productId, { isFeatured: !product.isFeatured })
    await auditLog(ctx.from.id, 'product.featured', { productId, isFeatured: !product.isFeatured })
    await ctx.answerCbQuery(product.isFeatured ? 'Imeondolewa kwenye Featured' : '⭐ Imewekwa Featured')
    await showProductDetail(ctx, productId)
  })

  // Release Pre-Order product
  bot.action(/^admin:prod:release:(\d+)$/, isAdmin, async (ctx) => {
    const productId = parseInt(ctx.match[1])
    await ctx.answerCbQuery('🚀 Kuanza kutuma bidhaa...')

    try {
      const { releasePreOrderOrders } = require('../services/orderService')

      // Update isPreOrder status in DB
      await updateProduct(productId, { isPreOrder: false })

      // Send the content to all buyers
      const deliveredCount = await releasePreOrderOrders(ctx.telegram, productId)

      await auditLog(ctx.from.id, 'product.released', { productId, deliveredCount })
      await ctx.reply(`✅ Bidhaa imewekwa LIVE! Maudhui yametumwa kwa wateja wote ${deliveredCount} walioagiza mapema.`)
      await showProductDetail(ctx, productId)
    } catch (err) {
      logger.error('Failed to release pre-order', { error: err.message, productId })
      await ctx.reply(`❌ Hitilafu ya kurelease bidhaa: ${err.message}`)
    }
  })

  // Delete product
  bot.action(/^admin:prod:delete:(\d+)$/, isAdmin, async (ctx) => {
    const productId = parseInt(ctx.match[1])
    await ctx.answerCbQuery()
    await ctx.editMessageText(
      '⚠️ *Una uhakika unataka kufuta bidhaa hii?*\n\nHaitaweza kurejeshwa\\.',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Ndiyo, Futa', `admin:prod:confirm_delete:${productId}`),
            Markup.button.callback('❌ Hapana', `admin:prod:view:${productId}`),
          ],
        ]),
      }
    )
  })

  bot.action(/^admin:prod:confirm_delete:(\d+)$/, isAdmin, async (ctx) => {
    const productId = parseInt(ctx.match[1])
    await deleteProduct(productId)
    await auditLog(ctx.from.id, 'product.deleted', { productId })
    await ctx.answerCbQuery('✅ Bidhaa imefutwa')
    await showProductsList(ctx, 1)
  })

  // Discount setup
  bot.action(/^admin:prod:discount:(\d+)$/, isAdmin, async (ctx) => {
    const productId = parseInt(ctx.match[1])
    await ctx.answerCbQuery()
    ctx.session.adminWizard = {
      scene: 'setDiscount',
      step: 'stars',
      data: { productId },
    }
    await ctx.editMessageText(
      '💸 *Weka Punguzo*\n\nAndika bei mpya ya punguzo \\(kwa Stars\\):\n_au andika 0 kufuta punguzo_',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Ghairi', `admin:prod:view:${productId}`)]]),
      }
    )
  })

  // Handle manual stock edit
  bot.action(/^admin:prod:stock:edit:(\d+)$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const productId = parseInt(ctx.match[1])

    ctx.session.adminWizard = {
      scene: 'edit_stock',
      step: 'amount',
      data: { productId }
    }
    await ctx.editMessageText('📦 *Update Stock*\n\nAndika nambari ya stock MPYA utakayoongeza (mfano: ukiandika 20 itaongeza 20 kwenye iliyopo), au andika "unlimited" kuondoa ukomo:', {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Ghairi', `admin:prod:view:${productId}`)]])
    })
  })

  // Add Category
  bot.action('admin:categories', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const { getCategories } = require('../services/productService')
    const cats = await getCategories()

    let text = '📂 *Usimamizi wa Categories:*\n\n'
    if (cats.length === 0) {
      text += '_Hakuna categories bado\\._\n'
    } else {
      text += '_Categories zenye bidhaa 0 zinaweza kufutwa kiotomatiki\\._\n'
    }

    const keyboardButtons = []
    cats.forEach(c => {
      const row = [
        Markup.button.callback(`${c.name} (${c._count.products})`, `admin:category:view:${c.id}`)
      ]
      if (c._count.products === 0) {
        row.push(Markup.button.callback('🗑️ Futa', `admin:category:delete:${c.id}`))
      }
      keyboardButtons.push(row)
    })

    keyboardButtons.push([
      Markup.button.callback('➕ Ongeza Category', 'admin:category:add'),
      Markup.button.callback('◀️ Rudi', 'admin:products')
    ])

    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard(keyboardButtons),
    })
  })

  bot.action(/^admin:category:view:(\d+)$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
  })

  bot.action(/^admin:category:delete:(\d+)$/, isAdmin, async (ctx) => {
    const catId = parseInt(ctx.match[1])
    const { prisma } = require('../database')

    try {
      const cat = await prisma.category.findUnique({
        where: { id: catId },
        include: { _count: { select: { products: true } } }
      })

      if (!cat) {
        await ctx.answerCbQuery('❌ Category haipatikani.', { show_alert: true })
        return
      }

      if (cat._count.products > 0) {
        await ctx.answerCbQuery(`❌ Category hii ina bidhaa ${cat._count.products} na haiwezi kufutwa.`, { show_alert: true })
        return
      }

      await prisma.category.delete({ where: { id: catId } })
      await ctx.answerCbQuery('✅ Category imefutwa!', { show_alert: true })

      // Refresh list
      const cats = await prisma.category.findMany({
        orderBy: { sortOrder: 'asc' },
        include: { _count: { select: { products: true } } }
      })

      let text = '📂 *Usimamizi wa Categories:*\n\n'
      if (cats.length === 0) {
        text += '_Hakuna categories bado\\._\n'
      } else {
        text += '_Categories zenye bidhaa 0 zinaweza kufutwa kiotomatiki\\._\n'
      }

      const keyboardButtons = []
      cats.forEach(c => {
        const row = [
          Markup.button.callback(`${c.name} (${c._count.products})`, `admin:category:view:${c.id}`)
        ]
        if (c._count.products === 0) {
          row.push(Markup.button.callback('🗑️ Futa', `admin:category:delete:${c.id}`))
        }
        keyboardButtons.push(row)
      })

      keyboardButtons.push([
        Markup.button.callback('➕ Ongeza Category', 'admin:category:add'),
        Markup.button.callback('◀️ Rudi', 'admin:products')
      ])

      await ctx.editMessageText(text, {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard(keyboardButtons),
      })

    } catch (err) {
      logger.error('Failed to delete category', { error: err.message, catId })
      await ctx.reply(`❌ Hitilafu: ${err.message}`)
    }
  })

  bot.action('admin:category:add', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    ctx.session.adminWizard = { scene: CAT_WIZARD, step: 'name', data: {} }
    await ctx.editMessageText(
      '📂 *Ongeza Category Mpya*\n\nAndika jina la category:',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Ghairi', 'admin:categories')]]),
      }
    )
  })
}

// ─── Message Handler kwa Wizard Steps ─────────────────────────

/**
 * Shughulikia wizard steps za admin (products, categories, discounts)
 * Inaitwa kwenye message handler ya kuu (src/bot.js)
 *
 * @param {import('telegraf').Context} ctx
 * @returns {boolean} true kama imeshughulikia, false kama hapana
 */
async function handleAdminProductWizard(ctx) {
  const wizard = ctx.session?.adminWizard
  if (!wizard) return false

  const text = ctx.message?.text?.trim()
  const document = ctx.message?.document
  const photo = ctx.message?.photo

  // ─── Add Product Wizard ────────────────────────────────────
  if (wizard.scene === WIZARD) {
    return await handleAddProductStep(ctx, wizard, text, document, photo)
  }

  // ─── Set Discount Wizard ───────────────────────────────────
  if (wizard.scene === 'setDiscount') {
    return await handleDiscountStep(ctx, wizard, text)
  }

  // ─── Edit Stock Wizard ───────────────────────────────────
  if (wizard.scene === 'edit_stock') {
    return await handleEditStockStep(ctx, wizard, text)
  }

  // ─── Add Category Wizard ───────────────────────────────────
  if (wizard.scene === CAT_WIZARD) {
    return await handleAddCategoryStep(ctx, wizard, text)
  }

  return false
}

// ─── Add Product Steps ────────────────────────────────────────

async function handleAddProductStep(ctx, wizard, text, document, photo) {
  const { step, data } = wizard

  switch (step) {
    case 'name': {
      if (!text || text.length < 2) {
        await ctx.reply('⚠️ Jina lazima liwe na herufi angalau 2. Jaribu tena:')
        return true
      }
      data.name = sanitizeText(text).substring(0, 100)
      wizard.step = 'description'
      await ctx.reply(
        '✅ Jina: *' + escapeMarkdown(data.name) + '*\n\n*Hatua 2/7:* Andika *maelezo* ya bidhaa:',
        { parse_mode: 'MarkdownV2' }
      )
      return true
    }

    case 'description': {
      if (!text || text.length < 2) {
        await ctx.reply('⚠️ Maelezo lazima yawe na herufi angalau 2. Jaribu tena:')
        return true
      }
      data.description = sanitizeText(text).substring(0, 4000)
      wizard.step = 'category'

      // Onyesha categories za kuchagua
      const categories = await getCategories()
      if (categories.length === 0) {
        data.categoryId = null // Itashughulikiwa baadaye
        wizard.step = 'price'
        await ctx.reply(
          '⚠️ Hakuna categories bado\\. Tafadhali ongeza category kwanza\\.\\n/admin → Bidhaa → Categories',
          { parse_mode: 'MarkdownV2' }
        )
        return true
      }

      const buttons = categories.map(c => [
        Markup.button.callback(c.name, `admin:wizard:cat:${c.id}`)
      ])
      buttons.push([Markup.button.callback('➕ Category Mpya', 'admin:wizard:cat:new')])

      await ctx.reply(
        '✅ Maelezo yamehifadhiwa\\.\n\n*Hatua 3/7:* Chagua *category*:',
        { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) }
      )
      return true
    }

    case 'new_category_name': {
      if (!text || text.length < 2) {
        await ctx.reply('⚠️ Jina la category lazima liwe na herufi angalau 2. Andika tena:')
        return true
      }
      const category = await createCategory(sanitizeText(text))
      data.categoryId = category.id

      wizard.step = 'price'
      await ctx.reply(
        `✅ Category *${escapeMarkdown(category.name)}* imeundwa na kuchaguliwa\\!\n\n` +
        `*Hatua 4/7:* Andika *bei* ya bidhaa \\(mfano: \`15000\` kwa TZS au \`$5.99\` kwa USD\\):`,
        { parse_mode: 'MarkdownV2' }
      )
      return true
    }

    case 'price': {
      const usdRate = config.payments?.binance?.usdtToTzsRate || 2600
      let priceTzs, priceUsd

      // Clean the input text loosely
      let cleanText = text.toLowerCase()
        .replace(/tzs|tsh|shs|shilingi|sh|\/=|\//g, '')
        .trim()

      const isUsd = cleanText.includes('$') || text.includes('$')
      cleanText = cleanText.replace(/[$,\s]/g, '')

      if (isUsd) {
        const val = parseFloat(cleanText)
        if (isNaN(val) || val <= 0) {
          await ctx.reply('⚠️ Andika bei ya USD iliyo sahihi, mfano: $5 au 5$')
          return true
        }
        priceUsd = val
        priceTzs = Math.round(priceUsd * usdRate)
      } else {
        const val = parseInt(cleanText, 10)
        if (isNaN(val) || val <= 0) {
          await ctx.reply('⚠️ Andika bei sahihi ya TZS (mfano: 150000 au 150,000) au USD (mfano: $5):')
          return true
        }
        priceTzs = val
        priceUsd = Math.round((priceTzs / usdRate) * 100) / 100
      }

      data.priceTzs = priceTzs
      data.priceUsd = priceUsd
      wizard.step = data.productType === 'text_content' ? 'preview_desc' :
                    data.productType === 'subscription' ? 'sub_days' : 
                    data.productType === 'bundle' ? 'bundle_products' : 'file_upload'

      const displayPrice = `TZS ${priceTzs.toLocaleString('en-US')} \\(approx\\. $${escapeMarkdown(priceUsd.toFixed(2))}\\)`

      if (data.productType === 'file') {
        await ctx.reply(
          `✅ Bei: ${displayPrice}\n\n*Hatua 5/7:* Pakia *faili* la bidhaa \\(PDF, ZIP, n\\.k\\.\\):\n` +
          `_Ukubwa wa juu: ${config.storage.maxFileSizeMB}MB_`,
          { parse_mode: 'MarkdownV2' }
        )
      } else if (data.productType === 'text_content') {
        await ctx.reply(
          `✅ Bei: ${displayPrice}\n\n*Hatua 5/7:* Andika *preview/teaser description* \\(inayoonekana kwa umma kabla ya kununua\\):`,
          { parse_mode: 'MarkdownV2' }
        )
      } else if (data.productType === 'subscription') {
        await ctx.reply(
          `✅ Bei: ${displayPrice}\n\n*Hatua 5/7:* Usajili huu unaisha baada ya siku ngapi? \\(mfano: 30 kwa mwezi\\)`,
          { parse_mode: 'MarkdownV2' }
        )
      } else if (data.productType === 'bundle') {
        await ctx.reply(
          `✅ Bei: ${displayPrice}\n\n*Hatua 5/7:* Andika ID za bidhaa zinazounda huu mgawanyo/bundle \\(Tenganisha kwa koma, mfano: 12, 15, 19\\):`,
          { parse_mode: 'MarkdownV2' }
        )
      }
      return true
    }

    case 'bundle_products': {
      if (!text || text.length < 1) {
        await ctx.reply('⚠️ Tafadhali andika ID za bidhaa (mfano: 12, 15):')
        return true
      }
      const ids = text.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
      if (ids.length === 0) {
        await ctx.reply('⚠️ Hakuna ID sahihi zilizopatikana. Jaribu tena (mfano: 12, 15):')
        return true
      }
      
      data.bundledIds = ids
      wizard.step = 'features'
      await ctx.reply(
        `✅ Bidhaa ${ids.length} zimeunganishwa kwenye bundle\\.\n\n*Hatua 6a:* Andika *features/mambo utakayopata* \\(mstari mmoja kwa feature\\):\n` +
        '_Mfano:\n✅ Starter Pack Bundle\n✅ 3 in 1 Package_\n\n' +
        'Au andika "skip" kuruka hatua hii:',
        { parse_mode: 'MarkdownV2' }
      )
      return true
    }

    case 'preview_desc': {
      data.previewDescription = sanitizeText(text || '').substring(0, 2000)
      wizard.step = 'features'
      await ctx.reply(
        '✅ Preview description imehifadhiwa\\.\n\n*Hatua 6a:* Andika *features/mambo utakayopata* \\(mstari mmoja kwa feature\\):\n' +
        '_Mfano:\n✅ Mbinu 10 za biashara\n✅ Templates za bure\n✅ Support ya wiki moja_\n\n' +
        'Au andika "skip" kuruka hatua hii:',
        { parse_mode: 'MarkdownV2' }
      )
      return true
    }

    case 'features': {
      if (text && text.toLowerCase() !== 'skip') {
        data.features = text.split('\n').map(f => f.trim()).filter(Boolean)
      }
      wizard.step = 'locked_content'
      await ctx.reply(
        '✅ Features zimehifadhiwa\\.\n\n*Hatua 6b:* Sasa andika/paste *MAUDHUI KAMILI* ambayo yatafikia mnunuzi tu:\n\n' +
        '⚠️ _Maudhui haya hayataonekana kwa mtu yeyote bila kulipa\\._',
        { parse_mode: 'MarkdownV2' }
      )
      return true
    }

    case 'locked_content': {
      if (!text || text.length < 10) {
        await ctx.reply('⚠️ Maudhui lazima yawe na herufi angalau 10. Jaribu tena:')
        return true
      }
      data.lockedContent = text // Hifadhi bila sanitize (tunajua ni admin)
      wizard.step = 'thumbnail'
      await ctx.reply(
        '✅ Maudhui yamehifadhiwa salama\\.\n\n*Hatua 7/7:* Pakia *picha ya bidhaa* \\(thumbnail\\):\n' +
        '_Au andika "skip" kama hutaka picha_',
        { parse_mode: 'MarkdownV2' }
      )
      return true
    }

    case 'file_upload': {
      if (document) {
        const filename = document.file_name || 'upload'
        data.fileTelegramId = document.file_id
        data.fileOriginalName = filename
        data.filePath = null
      } else if (text && (text.startsWith('http://') || text.startsWith('https://') || text.includes('://'))) {
        data.filePath = text
        data.fileTelegramId = null
        data.fileOriginalName = 'Kiungo cha Kupakua (URL Link)'
      } else {
        await ctx.reply('⚠️ Tafadhali pakia faili (Document) au andika kiungo cha faili (mfano: https://mega.nz/...)')
        return true
      }

      wizard.step = 'thumbnail'
      await ctx.reply(
        `✅ ${data.filePath ? 'Kiungo cha faili kimepokelewa' : 'Faili limepokelewa'}\n\n` +
        `*Hatua 7/7:* Pakia *picha ya bidhaa* \\(thumbnail\\):\n` +
        `_Au andika "skip" kama hutaka picha_`,
        { parse_mode: 'MarkdownV2' }
      )
      return true
    }

    case 'sub_days': {
      const days = parseNumber(text)
      if (!days || days < 1 || days > 3650) {
        await ctx.reply('⚠️ Andika idadi ya siku (1-3650). Mfano: 30')
        return true
      }
      data.subscriptionDays = days
      wizard.step = 'thumbnail'
      await ctx.reply(
        `✅ Usajili: Siku ${days}\n\n*Hatua 7/7:* Pakia *picha ya bidhaa* \\(thumbnail\\):\n_Au andika "skip"_`,
        { parse_mode: 'MarkdownV2' }
      )
      return true
    }

    case 'thumbnail': {
      if (photo && photo.length > 0) {
        // Chagua ubora wa juu zaidi wa picha
        const bestPhoto = photo[photo.length - 1]
        data.thumbnailFileId = bestPhoto.file_id
      } else if (text && text.toLowerCase() !== 'skip') {
        await ctx.reply('⚠️ Tafadhali tuma picha au andika "skip"')
        return true
      }

      wizard.step = 'stock'
      await ctx.reply(
        '✅ Picha imehifadhiwa\\.\n\n*Hatua ya Mwisho:* Bidhaa ina stock ngapi?\n' +
        '_Andika nambari au "unlimited" kwa stock isiyo na ukomo_',
        { parse_mode: 'MarkdownV2' }
      )
      return true
    }

    case 'stock': {
      let stock = null
      if (text && text.toLowerCase() !== 'unlimited') {
        stock = parseNumber(text)
        if (stock === null || stock < 0) {
          await ctx.reply('⚠️ Andika nambari ya stock au "unlimited"')
          return true
        }
      }
      data.stock = stock

      wizard.step = 'vip_only'
      await ctx.reply(
        `❓ Je, bidhaa hii ni maalum kwa wanachama wa VIP tu?\n\n` +
        `Andika *ndiyo* au *hapana*:`,
        { parse_mode: 'MarkdownV2' }
      )
      return true
    }

    case 'vip_only': {
      const input = text?.toLowerCase()?.trim()
      data.isVipOnly = (input === 'ndiyo' || input === 'yes' || input === '1')
      wizard.step = 'pre_order'
      await ctx.reply(
        `❓ Je, hii ni Pre\\-Order \\(mteja kulipia kabla bidhaa haijawa rasmi\\)?\n\n` +
        `Andika *ndiyo* au *hapana*:`,
        { parse_mode: 'MarkdownV2' }
      )
      return true
    }

    case 'pre_order': {
      const input = text?.toLowerCase()?.trim()
      data.isPreOrder = (input === 'ndiyo' || input === 'yes' || input === '1')
      await showProductConfirmation(ctx, wizard)
      return true
    }

    case 'confirm': {
      if (text?.toLowerCase() === 'ndiyo' || text?.toLowerCase() === 'yes') {
        await saveProduct(ctx, wizard)
      } else {
        ctx.session.adminWizard = null
        await ctx.reply('❌ Umeacha wizard. Bidhaa haikuhifadhiwa.', backToProductsKeyboard())
      }
      return true
    }

    default:
      return false
  }
}

// ─── Category selection within wizard ─────────────────────────

// Hii inashughulikiwa kama callback action ndani ya wizard
// Tunaihitaji bot.action handler - inaweza kuongezwa hapa
function registerWizardCategoryCallback(bot) {
  bot.action(/^admin:wizard:cat:(\d+|new)$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const wizard = ctx.session?.adminWizard
    if (!wizard || wizard.scene !== WIZARD || wizard.step !== 'category') return

    const catId = ctx.match[1]
    if (catId === 'new') {
      // Ombea jina la category mpya
      ctx.session.adminWizard.prevScene = WIZARD
      ctx.session.adminWizard.step = 'new_category_name'
      await ctx.reply('Andika jina la category mpya:')
      return
    }

    wizard.data.categoryId = parseInt(catId)
    wizard.step = 'price'

    await ctx.editMessageText(
      `✅ Category imechaguliwa\\.\n\n*Hatua 4/7:* Andika *bei* ya bidhaa \\(mfano: \`15000\` kwa TZS au \`$5.99\` kwa USD\\):`,
      { parse_mode: 'MarkdownV2' }
    )
  })
}

// ─── Show Confirmation ────────────────────────────────────────

async function showProductConfirmation(ctx, wizard) {
  const d = wizard.data
  const typeIcons = { file: '📁', text_content: '📄', subscription: '🔄' }

  let text = [
    `🔍 *Thibitisha Bidhaa Mpya:*`,
    ``,
    `📦 Jina: *${escapeMarkdown(d.name)}*`,
    `📝 Aina: ${typeIcons[d.productType]} ${escapeMarkdown(d.productType)}`,
    `💰 Bei: TZS ${d.priceTzs.toLocaleString('en-US')} \\(approx\\. $${escapeMarkdown(d.priceUsd.toFixed(2))}\\)`,
    `📊 Stock: ${escapeMarkdown(String(d.stock === null ? 'Unlimited' : d.stock))}`,
    `👑 VIP Only: ${d.isVipOnly ? 'Ndiyo ✅' : 'Hapana ❌'}`,
    `🔜 Pre\\-Order: ${d.isPreOrder ? 'Ndiyo ✅' : 'Hapana ❌'}`,
    d.features ? `✅ Features: ${d.features.length}` : '',
    d.lockedContent ? `🔒 Maudhui ya siri: ${escapeMarkdown(d.lockedContent.substring(0, 50))}\\.\\.\\.` : '',
    d.fileTelegramId ? `📁 Faili: ${escapeMarkdown(d.fileOriginalName || 'Imepakiwa')}` : '',
    (d.filePath && !d.fileTelegramId) ? `🔗 Kiungo: ${escapeMarkdown(d.filePath)}` : '',
    d.thumbnailFileId ? `🖼️ Picha: ✅` : `🖼️ Picha: ❌`,
    ``,
    `Andika *ndiyo* kuthibitisha au *hapana* kughairi:`,
  ].filter(Boolean).join('\n')

  wizard.step = 'confirm'
  await ctx.reply(text, { parse_mode: 'MarkdownV2' })
}

// ─── Save Product ─────────────────────────────────────────────

async function saveProduct(ctx, wizard) {
  const d = wizard.data
  ctx.session.adminWizard = null

  try {
    const product = await createProduct(d)
    await auditLog(ctx.from.id, 'product.created', { productId: product.id, name: product.name })

    // Auto-post kwenye channel
    const { postToChannel } = require('../services/channelService')
    await postToChannel(ctx.tg || ctx.telegram ? ctx : { telegram: require('../database').bot.telegram }, product, true, 0)

    await ctx.reply(
      `✅ *Bidhaa imeundwa kwa mafanikio\\!*\n\n` +
      `📦 *${escapeMarkdown(product.name)}*\n` +
      `🆔 ID: ${product.id}\n` +
      `💰 Bei: TZS ${product.priceTzs.toLocaleString('en-US')} \\(approx\\. $${escapeMarkdown(product.priceUsd.toFixed(2))}\\)`,
      { parse_mode: 'MarkdownV2', ...backToProductsKeyboard() }
    )
  } catch (err) {
    logger.error('Product creation failed', { error: err.message })
    await ctx.reply(`❌ Hitilafu: ${err.message}`, backToProductsKeyboard())
  }
}

// ─── Discount Step ────────────────────────────────────────────

async function handleDiscountStep(ctx, wizard, text) {
  const { step, data } = wizard

  if (step === 'stars') {
    const usdRate = config.currency?.usdToTzsRate || 2600
    let discountTzs, discountUsd

    if (text.startsWith('$') || text.endsWith('$')) {
      const clean = text.replace('$', '').trim()
      const val = parseFloat(clean)
      if (isNaN(val) || val <= 0) {
        await ctx.reply('⚠️ Andika bei ya USD iliyo sahihi, mfano: $5')
        return true
      }
      discountUsd = val
      discountTzs = Math.round(discountUsd * usdRate)
    } else {
      const val = parseInt(text.replace(/,/g, '').trim(), 10)
      if (isNaN(val) || val < 0) {
        await ctx.reply('⚠️ Andika bei sahihi ya TZS (mfano: 15000) au USD (mfano: $5) au 0 kufuta punguzo:')
        return true
      }

      if (val === 0) {
        await setProductDiscount(data.productId, null, null, null, null)
        ctx.session.adminWizard = null
        await ctx.reply('✅ Punguzo limefutwa.', backToProductsKeyboard())
        return true
      }
      discountTzs = val
      discountUsd = Math.round((discountTzs / usdRate) * 100) / 100
    }

    data.discountTzs = discountTzs
    data.discountUsd = discountUsd
    wizard.step = 'end_date'
    await ctx.reply(
      `✅ Bei ya punguzo: TZS ${discountTzs.toLocaleString('en-US')} (approx. $${discountUsd})\n\nPunguzo linaisha lini?\n_Format: YYYY-MM-DD (mfano: 2024-12-31)_\n_Au "forever" kwa punguzo la kudumu_`,
    )
    return true
  }

  if (step === 'end_date') {
    let endsAt = null
    if (text && text.toLowerCase() !== 'forever') {
      const date = new Date(text)
      if (isNaN(date.getTime())) {
        await ctx.reply('⚠️ Format si sahihi. Tumia YYYY-MM-DD au "forever"')
        return true
      }
      endsAt = date
    }

    await setProductDiscount(data.productId, data.discountTzs, data.discountUsd, new Date(), endsAt)
    await auditLog(ctx.from.id, 'product.discount_set', {
      productId: data.productId,
      discountTzs: data.discountTzs,
      discountUsd: data.discountUsd,
    })
    ctx.session.adminWizard = null
    await ctx.reply(
      `✅ Punguzo limewekwa: TZS ${data.discountTzs.toLocaleString('en-US')} (approx. $${data.discountUsd})${endsAt ? ` hadi ${endsAt.toLocaleDateString()}` : ' (forever)'}`,
      backToProductsKeyboard()
    )
    return true
  }

  return false
}

// ─── Edit Stock Step ────────────────────────────────────────────

async function handleEditStockStep(ctx, wizard, text) {
  if (text?.toLowerCase() === 'unlimited') {
    const { prisma } = require('../database')
    const p = await prisma.product.update({
      where: { id: wizard.data.productId },
      data: { stock: null }
    })
    ctx.session.adminWizard = null
    await ctx.reply('✅ Stock imebadilishwa kuwa Unlimited.', backToProductsKeyboard())
    await showProductDetail(ctx, p.id)
    return true
  }

  const addedStock = parseInt(text?.replace(/,/g, '').trim(), 10)
  if (isNaN(addedStock) || addedStock <= 0) {
    await ctx.reply('⚠️ Andika nambari sahihi ya stock utakayoongeza (zaidi ya 0), au "unlimited":')
    return true
  }

  const { prisma } = require('../database')
  const p = await prisma.product.findUnique({ where: { id: wizard.data.productId } })
  const currentStock = p.stock || 0
  const newStock = currentStock + addedStock

  const updated = await prisma.product.update({
    where: { id: wizard.data.productId },
    data: { stock: newStock }
  })
  
  // Auto-post kwenye channel
  const { postToChannel } = require('../services/channelService')
  await postToChannel(ctx.tg || ctx.telegram ? ctx : { telegram: require('../database').bot.telegram }, updated, false, addedStock)

  ctx.session.adminWizard = null
  await ctx.reply(`✅ Stock imesasishwa kikamilifu! Zilizopo sasa hivi ni ${newStock}.`, backToProductsKeyboard())
  await showProductDetail(ctx, updated.id)
  return true
}

// ─── Add Category Step ────────────────────────────────────────

async function handleAddCategoryStep(ctx, wizard, text) {
  if (wizard.step === 'name') {
    if (!text || text.length < 2) {
      await ctx.reply('⚠️ Jina lazima liwe na herufi angalau 2:')
      return true
    }
    const category = await createCategory(sanitizeText(text))
    ctx.session.adminWizard = null
    await ctx.reply(
      `✅ Category *${escapeMarkdown(category.name)}* imeundwa\\!`,
      { parse_mode: 'MarkdownV2', ...backToProductsKeyboard() }
    )
    return true
  }
  return false
}

// ─── Display Functions ────────────────────────────────────────

async function showProductsList(ctx, page = 1) {
  const result = await adminGetProducts(page)

  if (result.products.length === 0) {
    await ctx.editMessageText(
      '📦 *Bidhaa Zangu*\n\nHakuna bidhaa bado\\. Ongeza bidhaa ya kwanza\\!',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Ongeza Bidhaa', 'admin:product:add')],
          [Markup.button.callback('📂 Categories', 'admin:categories')],
          [Markup.button.callback('◀️ Rudi', 'admin:menu')],
        ]),
      }
    )
    return
  }

  let text = `📦 *Bidhaa \\(${result.total}\\):*\n\n`
  for (const p of result.products) {
    const status = p.isActive ? '✅' : '❌'
    const featured = p.isFeatured ? '⭐' : ''
    text += `${status}${featured} *${escapeMarkdown(p.name)}* — TZS ${p.priceTzs.toLocaleString('en-US')} — ${p.salesCount} mauzo\n`
  }
  text += `\n📄 Ukurasa ${result.page}/${result.totalPages}`

  const buttons = result.products.map(p => [
    Markup.button.callback(`📦 ${p.name.substring(0, 25)}`, `admin:prod:view:${p.id}`)
  ])

  const navButtons = []
  if (result.hasPrev) navButtons.push(Markup.button.callback('◀️ Nyuma', `admin:products:page:${page - 1}`))
  if (result.hasNext) navButtons.push(Markup.button.callback('Mbele ▶️', `admin:products:page:${page + 1}`))
  if (navButtons.length) buttons.push(navButtons)

  buttons.push([Markup.button.callback('➕ Ongeza', 'admin:product:add'), Markup.button.callback('📂 Categories', 'admin:categories')])
  buttons.push([Markup.button.callback('◀️ Rudi', 'admin:menu')])

  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) })
}

async function showProductDetail(ctx, productId) {
  const { prisma } = require('../database')
  const p = await prisma.product.findUnique({
    where: { id: productId },
    include: { category: true },
  })

  if (!p) {
    await ctx.editMessageText('❌ Bidhaa haipatikani.', backToProductsKeyboard())
    return
  }

  const status = p.isActive ? '✅ Inafanya kazi' : '❌ Imezimwa'
  const featured = p.isFeatured ? '⭐ Featured' : '—'
  const discount = isDiscountActive(p) ? `TZS ${p.discountTzs.toLocaleString('en-US')} (approx. $${p.discountUsd.toFixed(2)})` : 'Hakuna punguzo'

  let text = [
    `📦 *${escapeMarkdown(p.name)}*`,
    ``,
    `🆔 ID: ${p.id}`,
    `📂 Category: ${escapeMarkdown(p.category?.name || 'N/A')}`,
    `🏷️ Aina: ${escapeMarkdown(p.productType)}`,
    `💰 Bei TZS: TZS ${p.priceTzs.toLocaleString('en-US')}`,
    `💰 Bei USD: $${p.priceUsd.toFixed(2)}`,
    `💸 Punguzo: ${discount}`,
    `📊 Mauzo: ${p.salesCount}`,
    `📦 Stock: ${p.stock === null ? 'Unlimited' : p.stock}`,
    `👑 VIP Only: ${p.isVipOnly ? 'Ndiyo ✅' : 'Hapana ❌'}`,
    `🔜 Pre-Order: ${p.isPreOrder ? 'Ndiyo ✅' : 'Hapana ❌'}`,
    `📊 Hali: ${status}`,
    `⭐ Featured: ${featured}`,
    `📅 Iliundwa: ${escapeMarkdown(new Date(p.createdAt).toLocaleDateString('sw-TZ'))}`,
  ].join('\n')

  const row1 = [
    Markup.button.callback(p.isActive ? '❌ Zima' : '✅ Washa', `admin:prod:toggle:${p.id}`),
    Markup.button.callback(p.isFeatured ? '☆ Unfeature' : '⭐ Feature', `admin:prod:feature:${p.id}`),
  ]

  const row2 = [
    Markup.button.callback('💸 Punguzo', `admin:prod:discount:${p.id}`),
    Markup.button.callback('📦 Update Stock', `admin:prod:stock:edit:${p.id}`),
  ]
  const row3 = [
    Markup.button.callback('🗑️ Futa', `admin:prod:delete:${p.id}`),
  ]

  const keyboardRows = [row1, row2, row3]

  // Kama ni pre-order na ipo active, ongeza kitufe cha kuiweka Live
  if (p.isPreOrder && p.isActive) {
    keyboardRows.push([
      Markup.button.callback('🚀 Weka LIVE (Release)', `admin:prod:release:${p.id}`)
    ])
  }

  keyboardRows.push([Markup.button.callback('◀️ Orodha', 'admin:products')])

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard(keyboardRows),
  })
}

// ─── Helpers ─────────────────────────────────────────────────

function backToProductsKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('◀️ Bidhaa', 'admin:products')]])
}

module.exports = {
  registerAdminProductHandlers,
  handleAdminProductWizard,
  registerWizardCategoryCallback,
}
