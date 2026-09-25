// pm2 で常時稼働させる場合の設定: `pm2 start ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name: 'xero-tournament-bot',
      script: 'dist/index.js',
      cwd: __dirname,
      autorestart: true,
      max_memory_restart: '1G',
      env: { NODE_ENV: 'production' },
    },
  ],
};
