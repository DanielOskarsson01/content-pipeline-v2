// Server: Hetzner CX22 — 2 vCPU, 4 GB RAM
// Memory budget: OS+nginx ~300MB, Redis ~100MB, apps ~3.5GB, buffer ~150MB
//
// Source of truth for every PM2 app on this host. Includes apps that live
// outside the skeleton repo's tree (profile-api at /opt/profile-api, meal-api
// at /var/www/meals-api) so a single `pm2 start ecosystem.config.cjs` from
// /opt/content-pipeline-v2 reproduces full state.
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

    // ── Meal API ────────────────────────────────────────────────
    // Weekly meal planner ("Pantry API", port 3002). Lightweight express
    // service. Non-standard location: /var/www/meals-api/ (legacy from a
    // pre-/opt/ deployment).
    {
      name: 'meal-api',
      script: 'index.js',
      cwd: '/var/www/meals-api',
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '150M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
