module.exports = {
  apps: [
    {
      name: 'telegram-store-bot',
      script: './src/index.js',
      instances: 1, // Polling mode inahitaji instance moja tu
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',

      // Environment variables
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },

      // Logging
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Restart settings
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '30s',

      // Graceful shutdown
      kill_timeout: 10000,
      wait_ready: true,
      listen_timeout: 10000,

      // Cron job kwa cleanup (ikiwa PM2 Pro ipo)
      // cron_restart: '0 4 * * *',
    },
  ],
}
