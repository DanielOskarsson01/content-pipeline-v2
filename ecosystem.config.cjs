module.exports = {
  apps: [
    // ── API Server ──────────────────────────────────────────────
    // Express only — no workers, no Playwright.
    {
      name: 'pipeline-api',
      script: 'server/server.js',
      cwd: '/opt/content-pipeline-v2',
      node_args: '--env-file=.env',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '1G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/opt/content-pipeline-v2/logs/api-error.log',
      out_file: '/opt/content-pipeline-v2/logs/api-output.log',
      merge_logs: true,
    },

    // ── Stage Worker ────────────────────────────────────────────
    // Executes submodules (Playwright, AI calls, scraping). Memory-heavy.
    {
      name: 'stage-worker',
      script: 'server/workers/stageWorker.js',
      cwd: '/opt/content-pipeline-v2',
      node_args: '--env-file=.env',
      env: {
        NODE_ENV: 'production',
        WORKER_CONCURRENCY: 5,
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 5000,
      max_memory_restart: '4G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/opt/content-pipeline-v2/logs/stage-worker-error.log',
      out_file: '/opt/content-pipeline-v2/logs/stage-worker-output.log',
      merge_logs: true,
    },

    // ── Batch Worker ────────────────────────────────────────────
    // Lightweight — just counts entity results and updates DB.
    {
      name: 'batch-worker',
      script: 'server/workers/batchWorker.js',
      cwd: '/opt/content-pipeline-v2',
      node_args: '--env-file=.env',
      env: {
        NODE_ENV: 'production',
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '1G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/opt/content-pipeline-v2/logs/batch-worker-error.log',
      out_file: '/opt/content-pipeline-v2/logs/batch-worker-output.log',
      merge_logs: true,
    },
  ],
};
