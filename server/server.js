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
import seedRouter from './routes/seed.js';
import csvUploadRouter from './routes/csvUpload.js';
import { loadModules } from './services/moduleLoader.js';
import { startRetention } from './services/retention.js';
import db from './services/db.js';

// Workers run as separate PM2 processes — see ecosystem.config.cjs
// DO NOT import workers here. The API server should never spawn Playwright or process jobs.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Prevent browser HTTP caching of API responses — fixes stale data bug
// where step input_data shows as null despite being populated server-side
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});
app.set('etag', false);

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
app.use('/api/seed', seedRouter);
app.use('/api/projects/:projectId/csv-upload', csvUploadRouter);

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

// Startup recovery — auto-resume orphaned auto-executing runs (once per run).
// If the same run was already auto-resumed and the server restarted again, halt it permanently.
(async () => {
  try {
    // Clean up stale Redis locks first (before resuming)
    const { redis } = await import('./services/queue.js');
    const keys = await redis.keys('auto_execute:*');
    if (keys.length) {
      await redis.del(...keys);
      console.log(`[startup] Cleaned ${keys.length} stale auto-execute lock(s)`);
    }

    const { data: orphaned, error: orphanedErr } = await db
      .from('pipeline_runs')
      .select('id, auto_execute_state, project_id')
      .eq('status', 'auto_executing')
      .not('auto_execute_state', 'is', null);

    if (orphanedErr) throw orphanedErr;
    if (!orphaned?.length) {
      console.log('[startup] No orphaned auto-executing runs found');
      return;
    }

    const { executeRun } = await import('./services/autoExecutor.js');

    for (const run of orphaned) {
      const state = run.auto_execute_state || {};

      // Guard: if this run was already auto-resumed once, halt permanently
      if (state.auto_resumed) {
        await db
          .from('pipeline_runs')
          .update({
            status: 'halted',
            auto_execute_state: {
              ...state,
              halt_reason: 'Server restarted twice during execution — halted permanently',
              halted_at: new Date().toISOString(),
            },
          })
          .eq('id', run.id);
        console.log(`[startup] Halted run ${run.id} — already auto-resumed once`);
        continue;
      }

      // Resolve template execution_plan for config
      const haltedStep = state.halted_step ?? state.current_step ?? 0;
      let executionPlan = {};
      const { data: project } = await db
        .from('projects')
        .select('template_id')
        .eq('id', run.project_id)
        .single();

      if (project?.template_id) {
        const { data: template } = await db
          .from('templates')
          .select('execution_plan')
          .eq('id', project.template_id)
          .single();
        executionPlan = template?.execution_plan || {};
      }

      // Fallback: if no template (or empty submodules_per_step), build from run_submodule_config
      let submodulesPerStep = executionPlan.submodules_per_step || {};
      if (Object.keys(submodulesPerStep).length === 0) {
        const { data: runConfig } = await db
          .from('run_submodule_config')
          .select('step_index, submodule_id')
          .eq('run_id', run.id)
          .order('step_index', { ascending: true });
        if (runConfig?.length) {
          submodulesPerStep = {};
          for (const row of runConfig) {
            const key = String(row.step_index);
            if (!submodulesPerStep[key]) submodulesPerStep[key] = [];
            submodulesPerStep[key].push(row.submodule_id);
          }
          console.log(`[startup] Built submodulesPerStep from run_submodule_config for run ${run.id}`);
        }
      }

      const config = {
        steps: Array.from({ length: 11 }, (_, i) => i).filter(i => i >= haltedStep),
        skipSteps: [...(executionPlan.skip_steps || []).map(Number)],
        submodulesPerStep,
        failure_thresholds: {
          ...(state.failure_thresholds || {}),
          ...(executionPlan.failure_thresholds || {}),
        },
      };

      // Mark as auto-resumed so a second restart halts permanently
      const resumeState = { ...state, auto_resumed: true };

      console.log(`[startup] Auto-resuming run ${run.id} from step ${haltedStep}`);
      executeRun(run.id, config, resumeState);
    }
  } catch (err) {
    console.error('[startup] Auto-execute recovery failed:', err.message);
  }
})();

// Automated retention — delete run data older than 7 days
startRetention();

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
