'use strict'

const { Queue, Worker, QueueEvents } = require('bullmq')
const { Redis } = require('ioredis')
const config = require('../config')
const logger = require('../utils/logger')

// ─── Redis Connection kwa BullMQ ─────────────────────────────

const connection = new Redis(config.redis.url, {
  maxRetriesPerRequest: null, // BullMQ inahitaji null
  enableReadyCheck: false,
})

// ─── Queues ───────────────────────────────────────────────────

const abandonedCartQueue = new Queue('abandoned-cart', { connection })
const cleanupQueue = new Queue('cleanup', { connection })
const deliveryQueue = new Queue('delivery', { connection })
const subscriptionQueue = new Queue('subscriptions', { connection })

// ─── Queue Setup ──────────────────────────────────────────────

/**
 * Anza workers wote wa background jobs
 * @param {import('telegraf').Telegraf} bot
 */
async function startJobWorkers(bot) {
  logger.info('Starting background job workers...')

  // Abandoned Cart Worker
  const abandonedCartWorker = new Worker(
    'abandoned-cart',
    async (job) => {
      const { abandonedCartJob } = require('./abandonedCart')
      await abandonedCartJob(bot, job.data)
    },
    {
      connection,
      concurrency: 5,
    }
  )

  abandonedCartWorker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed`, { queue: 'abandoned-cart' })
  })

  abandonedCartWorker.on('failed', (job, err) => {
    logger.error(`Job ${job?.id} failed`, { queue: 'abandoned-cart', error: err.message })
  })

  // Cleanup Worker
  const cleanupWorker = new Worker(
    'cleanup',
    async (job) => {
      const { cleanupJob } = require('./cleanup')
      await cleanupJob(job.data)
    },
    {
      connection,
      concurrency: 1,
    }
  )

  cleanupWorker.on('failed', (job, err) => {
    logger.error(`Cleanup job failed`, { error: err.message })
  })

  // Delivery Worker (kwa async delivery)
  const deliveryWorker = new Worker(
    'delivery',
    async (job) => {
      const { deliverOrder } = require('../services/deliveryService')
      await deliverOrder(bot.telegram, job.data.telegramUserId, job.data.order)
    },
    {
      connection,
      concurrency: 3,
    }
  )

  deliveryWorker.on('failed', (job, err) => {
    logger.error(`Delivery job failed`, { orderId: job?.data?.order?.id, error: err.message })
  })

  // Subscription expiry worker
  const subscriptionWorker = new Worker(
    'subscriptions',
    async (job) => {
      await checkSubscriptionExpiry(bot)
    },
    { connection, concurrency: 1 }
  )

  logger.info('✅ Background job workers started')
}

// ─── Recurring Jobs (Cron) ────────────────────────────────────

/**
 * Weka cron jobs zinazoendelea mara kwa mara
 */
async function scheduleRecurringJobs() {
  // Angalia carts zilizoacha kila saa 1
  await abandonedCartQueue.add(
    'check-abandoned-carts',
    {},
    {
      repeat: { every: 60 * 60 * 1000 }, // Kila saa 1
      removeOnComplete: true,
    }
  )

  // Cleanup ya expired sessions/data kila usiku wa manane
  await cleanupQueue.add(
    'daily-cleanup',
    { type: 'daily' },
    {
      repeat: { cron: '0 0 * * *' }, // Kila usiku wa manane
      removeOnComplete: true,
    }
  )

  // Angalia subscription zinazokwisha kila siku saa 8 asubuhi
  await subscriptionQueue.add(
    'check-subscriptions',
    {},
    {
      repeat: { cron: '0 8 * * *' },
      removeOnComplete: true,
    }
  )

  logger.info('✅ Recurring jobs scheduled')
}

// ─── Manual Job Dispatch ──────────────────────────────────────

/**
 * Weka abandoned cart check kwa mtumiaji mmoja (baada ya kuongeza kwenye cart)
 */
async function scheduleAbandonedCartCheck(userId, delay = null) {
  const delayMs = (delay || config.jobs.abandonedCartReminderHours) * 60 * 60 * 1000

  await abandonedCartQueue.add(
    `check-user-${userId}`,
    { userId },
    {
      delay: delayMs,
      removeOnComplete: true,
      // Deduplicate: kama tayari kuna job kwa user huyu, isije ya ziada
      jobId: `abandoned-${userId}`,
    }
  )
}

/**
 * Tuma delivery kwa background (kwa orders kubwa)
 */
async function scheduleDelivery(telegramUserId, order) {
  await deliveryQueue.add(
    `deliver-order-${order.id}`,
    { telegramUserId, order },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
    }
  )
}

// ─── Subscription Check ───────────────────────────────────────

async function checkSubscriptionExpiry(bot) {
  const { prisma } = require('../database')

  // Pata subscriptions zinazokwisha ndani ya siku 3
  const soonExpiring = await prisma.userSubscription.findMany({
    where: {
      isActive: true,
      expiresAt: {
        gte: new Date(),
        lte: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    },
    include: {
      user: { select: { telegramId: true, language: true } },
      product: { select: { name: true } },
    },
  })

  for (const sub of soonExpiring) {
    const lang = sub.user.language || 'sw'
    const days = Math.ceil((new Date(sub.expiresAt) - new Date()) / (24 * 60 * 60 * 1000))

    const msg = lang === 'sw'
      ? `⏰ *Usajili Wako Unakwisha Karibuni\\!*\n\n📦 ${sub.product.name}\n📅 Inakwisha baada ya siku *${days}*\\.\n\nRenew sasa: /start`
      : `⏰ *Your Subscription Expiring Soon\\!*\n\n📦 ${sub.product.name}\n📅 Expires in *${days}* days\\.\n\nRenew now: /start`

    await bot.telegram.sendMessage(Number(sub.user.telegramId), msg, { parse_mode: 'MarkdownV2' })
      .catch(() => {})
  }

  // Futa subscriptions zilizokwisha
  await prisma.userSubscription.updateMany({
    where: { isActive: true, expiresAt: { lt: new Date() } },
    data: { isActive: false },
  })
}

module.exports = {
  abandonedCartQueue,
  cleanupQueue,
  deliveryQueue,
  startJobWorkers,
  scheduleRecurringJobs,
  scheduleAbandonedCartCheck,
  scheduleDelivery,
}
