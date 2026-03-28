import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import projectsRouter from './routes/projects.js';
import runsRouter from './routes/runs.js';
import submodulesRouter from './routes/submodules.js';
import submoduleConfigRouter from './routes/submoduleConfig.js';
import stepContextRouter from './routes/stepContext.js';
import { executeRouter, submoduleRunRouter, latestRunsRouter } from './routes/submoduleRuns.js';
import referenceDocsRouter from './routes/referenceDocs.js';
import presetsRouter from './routes/presets.js';
import templatesRouter from './routes/templates.js';
import { loadModules } from './services/moduleLoader.js';
import db from './services/db.js';

// Workers run as separate PM2 processes — see ecosystem.config.cjs
// DO NOT import workers here. The API server should never spawn Playwright or process jobs.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Static files — serve React build in production
const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientBuildPath));

// Routes
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Version endpoint — confirms what's actually deployed
// Reads build-info.json written by CI/CD before rsync
function readBuildInfo(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return { commit: 'unknown', message: '', time: '' }; }
}
const modulesDir = path.resolve(__dirname, '..', '..', 'content-pipeline-modules-v2');
app.get('/api/version', (_req, res) => res.json({
  skeleton: readBuildInfo(path.join(__dirname, '..', 'build-info.json')),
  modules: readBuildInfo(path.join(modulesDir, 'build-info.json')),
}));
app.use('/api/projects', projectsRouter);
app.use('/api/runs', runsRouter);
app.use('/api/submodules', submodulesRouter);
app.use('/api/runs/:runId/steps/:stepIndex/submodules/:submoduleId/config', submoduleConfigRouter);
app.use('/api/runs/:runId/steps/:stepIndex/submodules/:submoduleId', executeRouter);
app.use('/api/runs/:runId/steps/:stepIndex/context', stepContextRouter);
app.use('/api/runs/:runId/steps/:stepIndex/submodule-runs', latestRunsRouter);
app.use('/api/submodule-runs', submoduleRunRouter);
app.use('/api/projects/:projectId/reference-docs', referenceDocsRouter);
app.use('/api/presets', presetsRouter);
app.use('/api/templates', templatesRouter);

// Metrics endpoint — execution stats per submodule
app.get('/api/metrics/summary', async (_req, res, next) => {
  try {
    const { data, error } = await db
      .from('pipeline_metrics')
      .select('submodule_id, status, duration_ms, cost, created_at')
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) return res.json({ error: error.message, metrics: [] });

    // Group by submodule
    const bySubmodule = {};
    for (const row of (data || [])) {
      if (!bySubmodule[row.submodule_id]) {
        bySubmodule[row.submodule_id] = { total: 0, completed: 0, failed: 0, timeout: 0, avg_duration_ms: 0, durations: [] };
      }
      const s = bySubmodule[row.submodule_id];
      s.total++;
      if (row.status === 'completed') s.completed++;
      else if (row.status === 'failed') s.failed++;
      else if (row.status === 'timeout') s.timeout++;
      s.durations.push(row.duration_ms);
    }

    const metrics = Object.entries(bySubmodule).map(([id, s]) => ({
      submodule_id: id,
      total: s.total,
      completed: s.completed,
      failed: s.failed,
      timeout: s.timeout,
      avg_duration_ms: Math.round(s.durations.reduce((a, b) => a + b, 0) / s.durations.length),
      p95_duration_ms: Math.round(s.durations.sort((a, b) => a - b)[Math.floor(s.durations.length * 0.95)] || 0),
    }));

    res.json({ metrics });
  } catch (err) { next(err); }
});

// Load submodule manifests from MODULES_PATH
loadModules();

// SPA fallback — serve React app for non-API routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexPath = path.join(clientBuildPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    next();
  }
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err.stack || err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
