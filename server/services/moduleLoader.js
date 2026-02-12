import fs from 'fs';
import path from 'path';

const REQUIRED_FIELDS = ['id', 'name', 'description', 'version', 'step', 'category', 'cost', 'data_operation_default', 'requires_columns', 'item_key', 'output_schema'];
const VALID_STEPS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const VALID_COSTS = ['cheap', 'medium', 'expensive'];
const VALID_OPERATIONS = ['add', 'remove', 'transform'];

// In-memory registry: Map<submoduleId, manifest>
const registry = new Map();

/**
 * Validate a manifest has all required fields and valid values.
 * Returns null if valid, or an error message string if invalid.
 */
function validateManifest(manifest, filePath) {
  const missing = REQUIRED_FIELDS.filter(f => manifest[f] === undefined);
  if (missing.length > 0) {
    return `missing fields: ${missing.join(', ')}`;
  }

  if (!VALID_STEPS.includes(manifest.step)) {
    return `invalid step: ${manifest.step}`;
  }

  if (!VALID_COSTS.includes(manifest.cost)) {
    return `invalid cost: ${manifest.cost}`;
  }

  if (!VALID_OPERATIONS.includes(manifest.data_operation_default)) {
    return `invalid data_operation_default: ${manifest.data_operation_default}`;
  }

  if (!Array.isArray(manifest.requires_columns)) {
    return 'requires_columns must be an array';
  }

  if (typeof manifest.output_schema !== 'object' || manifest.output_schema === null) {
    return 'output_schema must be an object';
  }

  if (registry.has(manifest.id)) {
    return `duplicate id "${manifest.id}" (already registered)`;
  }

  return null;
}

/**
 * Scan MODULES_PATH for manifest.json files and populate the registry.
 * Directory structure: step-{N}-{name}/{submodule-name}/manifest.json
 */
export function loadModules() {
  const modulesPath = process.env.MODULES_PATH;
  if (!modulesPath) {
    console.warn('[moduleLoader] MODULES_PATH not set — no submodules loaded');
    return;
  }

  const modulesDir = path.resolve(modulesPath, 'modules');
  if (!fs.existsSync(modulesDir)) {
    console.warn(`[moduleLoader] modules directory not found: ${modulesDir}`);
    return;
  }

  registry.clear();

  const stepDirs = fs.readdirSync(modulesDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^step-\d+-/.test(d.name));

  for (const stepDir of stepDirs) {
    const stepPath = path.join(modulesDir, stepDir.name);
    const submoduleDirs = fs.readdirSync(stepPath, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const subDir of submoduleDirs) {
      const manifestPath = path.join(stepPath, subDir.name, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        console.warn(`[moduleLoader] No manifest.json in ${stepDir.name}/${subDir.name} — skipped`);
        continue;
      }

      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw);

        const error = validateManifest(manifest, manifestPath);
        if (error) {
          console.warn(`[moduleLoader] Invalid manifest ${stepDir.name}/${subDir.name}: ${error} — skipped`);
          continue;
        }

        // Store manifest with its filesystem path for later execute.js loading
        manifest._path = path.join(stepPath, subDir.name);
        registry.set(manifest.id, manifest);
        console.log(`[moduleLoader] Registered: ${manifest.id} (step ${manifest.step}, ${manifest.category})`);
      } catch (err) {
        console.warn(`[moduleLoader] Failed to parse ${stepDir.name}/${subDir.name}/manifest.json: ${err.message} — skipped`);
      }
    }
  }

  console.log(`[moduleLoader] ${registry.size} submodule(s) loaded`);
}

/**
 * Get all registered submodules, optionally filtered by step.
 */
export function getSubmodules(stepIndex) {
  const all = Array.from(registry.values());
  if (stepIndex !== undefined) {
    return all.filter(m => m.step === stepIndex);
  }
  return all;
}

/**
 * Get a single submodule by ID.
 */
export function getSubmoduleById(id) {
  return registry.get(id) || null;
}

/**
 * Get submodules grouped by category for a specific step.
 * Returns array of { category, submodules: [...] }
 */
export function getSubmodulesGroupedByCategory(stepIndex) {
  const submodules = getSubmodules(stepIndex);
  const groups = {};

  for (const manifest of submodules) {
    const cat = manifest.category;
    if (!groups[cat]) {
      groups[cat] = [];
    }
    groups[cat].push({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      category: manifest.category,
      cost: manifest.cost,
      data_operation_default: manifest.data_operation_default,
      requires_columns: manifest.requires_columns,
      item_key: manifest.item_key,
      options: manifest.options || [],
      options_defaults: manifest.options_defaults || {},
      output_schema: manifest.output_schema,
    });
  }

  return groups;
}
