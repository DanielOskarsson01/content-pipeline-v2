import fs from 'fs';
import path from 'path';
import { PROVIDERS } from '../config/llmRegistry.js';

const REQUIRED_FIELDS = ['id', 'name', 'description', 'version', 'step', 'category', 'cost', 'data_operation_default', 'requires_columns', 'item_key', 'output_schema'];
const VALID_STEPS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const VALID_COSTS = ['cheap', 'medium', 'expensive'];
const VALID_OPERATIONS = ['add', 'remove', 'transform'];
const VALID_POOL_PRECONDITIONS = ['empty_ok', 'requires_items'];

// In-memory registry: Map<submoduleId, manifest>
const registry = new Map();

/**
 * Resolve a manifest option's `values_from` spec to a list of dropdown keys drawn
 * from the shared LLM registry (BACKLOG #49). Generic mechanism — any option can
 * declare it; nothing here is submodule-specific.
 *   "registry.providers" → provider ids  ['anthropic','openai','perplexity','gemini']
 *   "registry.models"    → all model keys (flat, every provider)
 * Returns null for an unrecognised spec (leaves the option without values — a
 * visibly-empty dropdown, not a silent wrong list).
 */
function registryValues(spec) {
  if (spec === 'registry.providers') return Object.keys(PROVIDERS);
  if (spec === 'registry.models') return Object.values(PROVIDERS).flatMap((p) => Object.keys(p.models));
  return null;
}

/**
 * Populate `option.values` for any option declaring `values_from`, in place.
 * The worker ignores option.values (it resolves via resolveModel); this exists so
 * the served manifest drives the client dropdown from the registry.
 */
export function applyRegistryOptionValues(manifest) {
  for (const opt of manifest.options || []) {
    if (opt && typeof opt.values_from === 'string') {
      const vals = registryValues(opt.values_from);
      if (vals) opt.values = vals;
    }
  }
  return manifest;
}

/**
 * Validate a manifest before registering it. Throws on any violation —
 * intentionally fail-closed so audit gaps cause immediate startup failure
 * rather than silent runtime drops. See modules/CLAUDE.md rule 12 for the
 * declarative contract.
 */
export function validateManifest(manifest, manifestPath) {
  const missing = REQUIRED_FIELDS.filter(f => manifest[f] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Manifest ${manifestPath} missing fields: ${missing.join(', ')}`
    );
  }

  if (!VALID_STEPS.includes(manifest.step)) {
    throw new Error(
      `Manifest ${manifestPath} has invalid step: ${manifest.step}`
    );
  }

  if (!VALID_COSTS.includes(manifest.cost)) {
    throw new Error(
      `Manifest ${manifestPath} has invalid cost: ${manifest.cost}`
    );
  }

  // data_operation_default check (explicit throw with recognised message)
  if (!VALID_OPERATIONS.includes(manifest.data_operation_default)) {
    throw new Error(
      `Manifest ${manifestPath} has invalid data_operation_default ` +
      `"${manifest.data_operation_default}". Allowed: add, transform, remove.`
    );
  }

  if (!Array.isArray(manifest.requires_columns)) {
    throw new Error(
      `Manifest ${manifestPath} requires_columns must be an array`
    );
  }

  if (typeof manifest.output_schema !== 'object' || manifest.output_schema === null) {
    throw new Error(
      `Manifest ${manifestPath} output_schema must be an object`
    );
  }

  // pool_precondition must be declared (no default) — fail-closed
  if (!manifest.pool_precondition) {
    throw new Error(
      `Manifest ${manifestPath} missing required field 'pool_precondition'. ` +
      `Set to "empty_ok" or "requires_items". See modules/CLAUDE.md rule 12.`
    );
  }

  if (!VALID_POOL_PRECONDITIONS.includes(manifest.pool_precondition)) {
    throw new Error(
      `Manifest ${manifestPath} has invalid pool_precondition ` +
      `"${manifest.pool_precondition}". Allowed: empty_ok, requires_items.`
    );
  }

  if (registry.has(manifest.id)) {
    throw new Error(
      `Manifest ${manifestPath} has duplicate id "${manifest.id}" (already registered)`
    );
  }
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

      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw);

      // Throws on any violation — fail-closed (no try/catch, invalid manifest = startup failure)
      validateManifest(manifest, manifestPath);

      // BACKLOG #49: the skeleton supplies option lists from the shared LLM
      // registry at load time. A manifest option declaring values_from:"registry.*"
      // (instead of a hardcoded values array) gets its values populated here, so
      // every AI submodule offers the SAME registry-driven provider/model list —
      // no per-manifest enumeration to drift, gemini/perplexity now selectable.
      applyRegistryOptionValues(manifest);

      // Store manifest with its filesystem path for later execute.js loading
      manifest._path = path.join(stepPath, subDir.name);
      registry.set(manifest.id, manifest);
      console.log(`[moduleLoader] Registered: ${manifest.id} (step ${manifest.step}, ${manifest.category})`);
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
      sort_order: manifest.sort_order ?? 99,
      active: manifest.active !== false,
    });
  }

  // Sort submodules within each category by sort_order
  for (const cat of Object.keys(groups)) {
    groups[cat].sort((a, b) => a.sort_order - b.sort_order);
  }

  return groups;
}
