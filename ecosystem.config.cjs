// Server: Hetzner CX22 — 2 vCPU, 4 GB RAM
// Memory budget: OS+nginx ~300MB, Redis ~100MB, apps ~3GB, buffer ~700MB
//
// Source of truth for the content-pipeline-v2 deployment surface: the 3
// skeleton apps (pipeline-api, stage-worker, batch-worker) plus profile-api
// (LinkedIn scraper at /opt/profile-api — runtime dependency of the
// linkedin-profile-scraper and linkedin-post-scraper submodules in
// modules-v2/step-3-scraping/, which hardcode localhost:3847).
//
// Unrelated apps on the same host (e.g. meal-api at /var/www/meals-api/)
// are out of scope for content-pipeline deploys and live in their own
// management. The Hetzner host may run other PM2 apps; this config
// does not claim global source-of-truth.
//
// All apps use exec_mode: 'fork'. PM2 6.0.14 cluster_mode is broken on this
// host (apps exit code 9 + SIGINT instantly). See docs/HETZNER_SERVICES.md.
module.exports = {
  apps: [
    // ── API Server ──────────────────────────────────────────────
    // Express only — no workers, no Playwright.
    {
      name: 'pipeline-api',
      script: 'server/server.js',
      cwd: '/opt/content-pipeline-v2',
      exec_mode: 'fork',
      node_args: '--env-file=.env --max-old-space-size=512',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '700M',
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
      exec_mode: 'fork',
      node_args: '--env-file=.env --max-old-space-size=1536',
      env: {
        NODE_ENV: 'production',
        WORKER_CONCURRENCY: 2,
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 5000,
      max_memory_restart: '2048M',
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
      exec_mode: 'fork',
      node_args: '--env-file=.env --max-old-space-size=256',
      env: {
        NODE_ENV: 'production',
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '350M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/opt/content-pipeline-v2/logs/batch-worker-error.log',
      out_file: '/opt/content-pipeline-v2/logs/batch-worker-output.log',
      merge_logs: true,
    },

    // ── Profile API ─────────────────────────────────────────────
    // LinkedIn profile/job scraper (port 3847). Spawns Chrome on display :1
    // via internal spawn() — Chrome memory is tracked by the kernel, not by
    // PM2's max_memory_restart for this process.
    // DISPLAY=:1 is also set by pm2-root.service for systemd-managed boots,
    // but is repeated here so `pm2 start ecosystem.config.cjs` outside
    // systemd still works.
    {
      name: 'profile-api',
      script: 'server.js',
      cwd: '/opt/profile-api',
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        DISPLAY: ':1',
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '300M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

  ],
};
