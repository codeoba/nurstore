'use strict'

const { prisma } = require('../database')
const { isDiscountActive } = require('../utils/formatting')
const logger = require('../utils/logger')

const PRODUCTS_PER_PAGE = 5

// ─── PUBLIC: Preview Functions (HAWATOI locked_content) ──────

/**
 * Pata orodha ya bidhaa kwa ukurasa (pagination)
 * USALAMA: locked_content haimo kwenye select - kamwe
 */
async function getProductsPage(page = 1, filters = {}) {
  const skip = (page - 1) * PRODUCTS_PER_PAGE

  const where = {
    isActive: true,
    ...(filters.categoryId && { categoryId: filters.categoryId }),
    ...(filters.productType && { productType: filters.productType }),
    ...(filters.isFeatured !== undefined && { isFeatured: filters.isFeatured }),
    ...(filters.search && {
      OR: [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ]
    }),
  }

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take: PRODUCTS_PER_PAGE,
      orderBy: filters.isFeatured
        ? [{ isFeatured: 'desc' }, { salesCount: 'desc' }]
        : { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        nameEn: true,
        description: true,
        descriptionEn: true,
        price: true,
        priceStars: true,
        productType: true,
        thumbnailPath: true,
        thumbnailFileId: true,
        stock: true,
        isFeatured: true,
        previewDescription: true,
        features: true,
        discountStars: true,
        discountStartsAt: true,
        discountEndsAt: true,
        salesCount: true,
        // MUHIMU: lockedContent HAIMO HAPA - salama kabisa
        category: { select: { id: true, name: true } },
        _count: { select: { reviews: true } },
      },
    }),
    prisma.product.count({ where }),
  ])

  return {
    products,
    total,
    page,
    totalPages: Math.ceil(total / PRODUCTS_PER_PAGE),
    hasNext: skip + PRODUCTS_PER_PAGE < total,
    hasPrev: page > 1,
  }
}

/**
 * Pata bidhaa moja kwa preview (bila locked_content)
 * @param {number} productId
 */
async function getProductPreview(productId) {
  const product = await prisma.product.findUnique({
    where: { id: productId, isActive: true },
    select: {
      id: true,
      name: true,
      nameEn: true,
      description: true,
      descriptionEn: true,
      price: true,
      priceStars: true,
      productType: true,
      thumbnailPath: true,
      thumbnailFileId: true,
      fileOriginalName: true,
      stock: true,
      isFeatured: true,
      previewDescription: true,
      features: true,
      discountStars: true,
      discountStartsAt: true,
      discountEndsAt: true,
      salesCount: true,
      subscriptionDays: true,
      contentFormat: true,
      category: { select: { id: true, name: true } },
      reviews: {
        take: 3,
        orderBy: { createdAt: 'desc' },
        select: {
          rating: true,
          comment: true,
          user: { select: { fullName: true, username: true } },
        },
      },
      _count: { select: { reviews: true } },
      // MUHIMU SANA: lockedContent HAIPO HAPA - kamwe isitoke
    },
  })

  return product
}

// ─── SECURE: Full Content (Baada ya Verification ya Malipo) ──

/**
 * Pata locked_content baada ya kuthibitisha malipo
 *
 * USALAMA:
 * 1. Thibitisha order ipo na status ni "delivered" au "paid"
 * 2. Thibitisha user_id inayoomba ndiyo iliyolipa
 * 3. Rate limit check (inafanyika kwenye middleware)
 *
 * @param {number} productId
 * @param {number} userId - ID ya mtumiaji wa database (siyo Telegram ID)
 * @returns {{ content: string, format: string } | null}
 */
async function getProductFullContent(productId, userId) {
  // Thibitisha kwamba user ana order iliyolipwa kwa bidhaa hii
  const validOrder = await prisma.orderItem.findFirst({
    where: {
      productId,
      order: {
        userId,
        status: { in: ['paid', 'delivered'] },
      },
    },
    include: {
      order: { select: { id: true, status: true } },
    },
  })

  if (!validOrder) {
    logger.security('UNAUTHORIZED_CONTENT_ACCESS', {
      productId,
      userId,
    })
    return null
  }

  // Sasa tu tunafetch locked_content
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      lockedContent: true,
      contentFormat: true,
      name: true,
    },
  })

  if (!product?.lockedContent) return null

  return {
    content: product.lockedContent,
    format: product.contentFormat,
    orderId: validOrder.order.id,
    productName: product.name,
  }
}

// ─── ADMIN: Functions (Zinahitaji isAdmin middleware) ────────

/**
 * Pata bidhaa zote kwa admin (pamoja na inactive)
 */
async function adminGetProducts(page = 1, filters = {}) {
  const skip = (page - 1) * PRODUCTS_PER_PAGE

  const where = {
    ...(filters.categoryId && { categoryId: filters.categoryId }),
    ...(filters.isActive !== undefined && { isActive: filters.isActive }),
    ...(filters.search && {
      OR: [
        { name: { contains: filters.search, mode: 'insensitive' } },
      ]
    }),
  }

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take: PRODUCTS_PER_PAGE,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        priceStars: true,
        productType: true,
        stock: true,
        isActive: true,
        isFeatured: true,
        salesCount: true,
        createdAt: true,
        category: { select: { name: true } },
      },
    }),
    prisma.product.count({ where }),
  ])

  return {
    products,
    total,
    page,
    totalPages: Math.ceil(total / PRODUCTS_PER_PAGE),
    hasNext: skip + PRODUCTS_PER_PAGE < total,
    hasPrev: page > 1,
  }
}

/**
 * Ongeza bidhaa mpya
 */
async function createProduct(data) {
  const product = await prisma.product.create({
    data: {
      name: data.name,
      nameEn: data.nameEn || null,
      description: data.description,
      price: data.priceStars * 32, // approximate TZS
      priceStars: data.priceStars,
      categoryId: data.categoryId,
      productType: data.productType,
      filePath: data.filePath || null,
      fileOriginalName: data.fileOriginalName || null,
      fileTelegramId: data.fileTelegramId || null,
      thumbnailPath: data.thumbnailPath || null,
      thumbnailFileId: data.thumbnailFileId || null,
      stock: data.stock ?? null,
      previewDescription: data.previewDescription || null,
      features: data.features || null,
      lockedContent: data.lockedContent || null,
      contentFormat: data.contentFormat || 'plain',
      subscriptionDays: data.subscriptionDays || null,
    },
  })

  logger.info('Product created', { productId: product.id, name: product.name })
  return product
}

/**
 * Hariri bidhaa
 */
async function updateProduct(productId, data) {
  const product = await prisma.product.update({
    where: { id: productId },
    data: {
      ...data,
      updatedAt: new Date(),
    },
  })

  logger.info('Product updated', { productId, fields: Object.keys(data) })
  return product
}

/**
 * Futa bidhaa (soft delete - inafanya inactive)
 */
async function deleteProduct(productId) {
  await prisma.product.update({
    where: { id: productId },
    data: { isActive: false },
  })
  logger.info('Product deactivated', { productId })
}

/**
 * Badilisha discount ya bidhaa
 */
async function setProductDiscount(productId, discountStars, startsAt, endsAt) {
  return prisma.product.update({
    where: { id: productId },
    data: {
      discountStars,
      discountStartsAt: startsAt,
      discountEndsAt: endsAt,
    },
  })
}

// ─── Categories ───────────────────────────────────────────────

/**
 * Pata categories zote zilizowashwa
 */
async function getCategories(parentId = null) {
  return prisma.category.findMany({
    where: {
      isActive: true,
      parentId: parentId === null ? null : parentId,
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      _count: { select: { products: { where: { isActive: true } } } },
    },
  })
}

/**
 * Pata category pamoja na sub-categories zake
 */
async function getCategoryWithChildren(categoryId) {
  return prisma.category.findUnique({
    where: { id: categoryId },
    include: {
      children: { where: { isActive: true } },
      _count: { select: { products: { where: { isActive: true } } } },
    },
  })
}

/**
 * Ongeza category mpya
 */
async function createCategory(name, parentId = null) {
  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  return prisma.category.create({
    data: { name, slug, parentId },
  })
}

// ─── Best Sellers & Featured ─────────────────────────────────

/**
 * Pata bidhaa zinazouzwa zaidi
 */
async function getBestSellers(limit = 5) {
  return prisma.product.findMany({
    where: { isActive: true },
    orderBy: { salesCount: 'desc' },
    take: limit,
    select: {
      id: true,
      name: true,
      priceStars: true,
      salesCount: true,
      thumbnailFileId: true,
      productType: true,
    },
  })
}

/**
 * Pata bidhaa zinazofanana (recommendations)
 * Msingi: bidhaa nyingine kwenye category ile ile
 */
async function getRecommendations(productId, limit = 3) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { categoryId: true },
  })

  if (!product) return []

  return prisma.product.findMany({
    where: {
      categoryId: product.categoryId,
      isActive: true,
      id: { not: productId },
    },
    orderBy: { salesCount: 'desc' },
    take: limit,
    select: {
      id: true,
      name: true,
      priceStars: true,
      discountStars: true,
      discountEndsAt: true,
      thumbnailFileId: true,
    },
  })
}

module.exports = {
  getProductsPage,
  getProductPreview,
  getProductFullContent,
  adminGetProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  setProductDiscount,
  getCategories,
  getCategoryWithChildren,
  createCategory,
  getBestSellers,
  getRecommendations,
  PRODUCTS_PER_PAGE,
}
