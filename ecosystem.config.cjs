module.exports = {
  apps: [
    {
      name: 'content-pipeline-v2',
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
      max_memory_restart: '2G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/opt/content-pipeline-v2/logs/error.log',
      out_file: '/opt/content-pipeline-v2/logs/output.log',
      merge_logs: true,
    },
  ],
};
