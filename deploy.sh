#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# 🚀 Telegram Store Bot — Deploy Script kwa aaPanel VPS
# Tumia: chmod +x deploy.sh && ./deploy.sh
# ═══════════════════════════════════════════════════════════════

set -e  # Simama kama kuna hitilafu

echo "════════════════════════════════════════════"
echo "🚀 Deploying Telegram Store Bot"
echo "════════════════════════════════════════════"

# ─── Check Prerequisites ─────────────────────────────────────
check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo "❌ $1 haipatikani. Tafadhali install kwanza."
        exit 1
    fi
}

check_command node
check_command npm
check_command pm2
check_command redis-cli
echo "✅ Zana zote zipo"

# ─── Check Node Version ───────────────────────────────────────
NODE_VERSION=$(node -v | cut -d'.' -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ inahitajika. Umeweka: $(node -v)"
    exit 1
fi
echo "✅ Node.js $(node -v)"

# ─── Check .env File ─────────────────────────────────────────
if [ ! -f ".env" ]; then
    echo "⚠️ .env haipo. Nakili .env.example..."
    cp .env.example .env
    echo "📝 Hariri .env kwanza: nano .env"
    echo "   Kisha run script hii tena."
    exit 1
fi

# Angalia BOT_TOKEN imewekwa
BOT_TOKEN=$(grep "^BOT_TOKEN=" .env | cut -d'=' -f2)
if [ -z "$BOT_TOKEN" ] || [ "$BOT_TOKEN" = "your-bot-token-here" ]; then
    echo "❌ BOT_TOKEN haijawekwa kwenye .env"
    exit 1
fi
echo "✅ .env imesanidiwa"

# ─── Install Dependencies ─────────────────────────────────────
echo ""
echo "📦 Kuinstall dependencies..."
npm install --omit=dev
echo "✅ Dependencies zimewekwa"

# ─── Create Directories ───────────────────────────────────────
echo ""
echo "📁 Kuunda directories..."
mkdir -p logs
mkdir -p uploads/products
mkdir -p uploads/temp
chmod 755 uploads
echo "✅ Directories zimeundwa"

# ─── Database Migration ───────────────────────────────────────
echo ""
echo "🗄️ Kurun database migration..."
npx prisma generate
npx prisma db push
echo "✅ Database imesanidiwa"

# ─── Redis Check ─────────────────────────────────────────────
echo ""
echo "📡 Kuangalia Redis..."
REDIS_URL=$(grep "^REDIS_URL=" .env | cut -d'=' -f2-)
if redis-cli -u "${REDIS_URL:-redis://localhost:6379}" ping &> /dev/null; then
    echo "✅ Redis inafanya kazi"
else
    echo "⚠️ Redis haijibu. Hakikisha Redis imewashwa:"
    echo "   sudo systemctl start redis"
fi

# ─── Stop Existing PM2 Process ────────────────────────────────
echo ""
echo "🛑 Kusimamisha bot ya zamani (kama ipo)..."
pm2 stop telegram-store-bot 2>/dev/null || echo "   (Hakuna process ya zamani)"
pm2 delete telegram-store-bot 2>/dev/null || true

# ─── Start with PM2 ──────────────────────────────────────────
echo ""
echo "🚀 Kuanzisha bot..."
NODE_ENV=production pm2 start ecosystem.config.js --env production
pm2 save  # Hifadhi kwa ajili ya reboot
echo "✅ Bot imeanzishwa!"

# ─── Status ──────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════"
echo "📊 Hali ya Bot:"
echo "════════════════════════════════════════════"
pm2 status telegram-store-bot

echo ""
echo "════════════════════════════════════════════"
echo "✅ Deploy imekamilika!"
echo ""
echo "📝 Amri Muhimu:"
echo "   pm2 logs telegram-store-bot    # Angalia logs"
echo "   pm2 restart telegram-store-bot # Restart bot"
echo "   pm2 stop telegram-store-bot    # Simamisha bot"
echo "   pm2 monit                      # Monitor moja kwa moja"
echo "════════════════════════════════════════════"
