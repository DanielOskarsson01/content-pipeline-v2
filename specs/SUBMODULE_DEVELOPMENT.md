# Submodule Development Guide

> **Companion to:** SKELETON_SPEC_v2.md (the skeleton specification)
> **Updated:** February 9, 2026

This guide explains how to create new submodules for the Content Creation Tool. Submodules live in a **separate repo** from the skeleton. Adding a new submodule requires no skeleton changes — create your folder, restart the skeleton, and it appears in the UI automatically.

---

## Quick Start

1. Create a folder: `modules/step-{N}-{name}/your-submodule/`
2. Add `manifest.json` (declares everything the skeleton needs to know)
3. Add `execute.js` (your processing logic)
4. Optionally add React components (e.g., `OptionsPanel.jsx` for custom options UI)
5. Restart the skeleton
6. Your submodule appears in the UI automatically

---

## Folder Structure

```
modules/                              ← Modules repo root
├── step-1-discovery/
│   ├── sitemap-parser/
│   │   ├── manifest.json
│   │   ├── execute.js
│   │   └── OptionsPanel.jsx          ← optional custom options UI
│   └── navigation-links/
│       ├── manifest.json
│       └── execute.js
├── step-2-validation/
│   ├── url-filter/
│   │   ├── manifest.json
│   │   └── execute.js
│   └── deduplicator/
│       ├── manifest.json
│       └── execute.js
└── step-3-scraping/
    └── web-scraper/
        ├── manifest.json
        ├── execute.js
        └── OptionsPanel.jsx
```

Each submodule folder contains at minimum `manifest.json` + `execute.js`. The skeleton auto-discovers all submodule folders at startup.

---

## The Manifest

The manifest is the complete interface declaration. The skeleton never reads your `execute.js` to understand your submodule — it reads the manifest for everything.

### Full Manifest Template

```json
{
  "id": "your-submodule",
  "name": "Your Submodule",
  "description": "One-line explanation shown in the UI.",
  "version": "1.0.0",
  "step": 1,
  "category": "website",
  "cost": "cheap",
  "data_operation_default": "add",

  "requires_columns": ["website"],

  "options": [
    {
      "name": "max_results",
      "type": "number",
      "label": "Maximum Results",
      "description": "Limit total results returned per entity.",
      "default": 1000,
      "min": 1,
      "max": 50000
    },
    {
      "name": "include_nested",
      "type": "boolean",
      "label": "Include nested sources",
      "description": "Follow references to discover additional sources.",
      "default": true
    },
    {
      "name": "filter_mode",
      "type": "select",
      "label": "Filter mode",
      "description": "Which patterns to include.",
      "default": "all",
      "values": ["all", "pages_only", "custom_regex"]
    }
  ],

  "options_defaults": {
    "max_results": 1000,
    "include_nested": true,
    "filter_mode": "all"
  },

  "options_component": "./OptionsPanel.jsx",

  "item_key": "url",

  "output_schema": {
    "display_type": "table",
    "url": "string (required)",
    "source_category": "string",
    "depth": "number",
    "last_modified": "string (ISO date, if available)"
  }
}
```

### Field Reference

| Field | Required | Purpose |
|-------|----------|---------|
| `id` | ✓ | Unique identifier. URL-safe (lowercase, hyphens). Once set, never changes. |
| `name` | ✓ | Display name shown on submodule cards. |
| `description` | ✓ | One-line explanation shown in the pane. |
| `version` | ✓ | Semantic version. Skeleton detects manifest changes via this. |
| `step` | ✓ | Which step (0–10) this submodule belongs to. One step only. |
| `category` | ✓ | Visual grouping within a step. Categories are visual only — no functional meaning. |
| `cost` | ✓ | `"cheap"`, `"medium"`, or `"expensive"`. Controls BullMQ priority and timeout. |
| `data_operation_default` | ✓ | `"add"`, `"remove"`, or `"transform"`. Default ➕➖＝ toggle. User can override per run. |
| `requires_columns` | ✓ | Which columns must exist in input data. Used for validation and CSV template generation. |
| `options` | | Array of option definitions. Used for documentation, validation, and fallback rendering. |
| `options_defaults` | | `{key: value}` pairs. Starting values when no saved config exists. |
| `options_component` | | Path to a React component for custom options UI. If omitted, skeleton auto-renders from `options[]`. |
| `item_key` | ✓ | Primary key field in output items (e.g., `"url"`). Used for deduplication and cross-run tracking. Can be a string for a single field or an array for composite keys (e.g., `["url", "entity_name"]`). |
| `output_schema` | ✓ | Describes output item shape + `display_type`. `display_type` values: `"table"` (columnar, default), `"url_list"` (compact URL rows), `"content_cards"` (article/document cards), `"file_list"` (filename + size + timestamp). |

---

## The Execute Function

Your `execute.js` exports a single async function. This is the only code the skeleton calls.

### Signature

```javascript
async function execute(input, options, tools) {
  // Your logic here
  return results;
}

module.exports = execute;
```

### Input

```javascript
{
  entities: [
    { name: "Company A", website: "companya.com", linkedin: "..." },
    { name: "Company B", website: "companyb.com" }
  ],
  run_id: "uuid",
  step_index: 1,
  submodule_id: "your-submodule"
}
```

`entities` is an array of objects. Every entity is guaranteed to have a `name` field (the skeleton enforces this on upload/import). Other fields depend on what was uploaded or inherited from the previous step. Check for fields listed in your `requires_columns` — the skeleton validates these exist before execution, but handle missing optional fields gracefully (skip entity, log warning).

**Entity scoping:** Your results are tied to entities. When you return results, group them by entity (see Return Format below). The skeleton uses this grouping to scope working pool operations per entity — Stripe's URLs never mix with PayPal's URLs.

### Options

```javascript
{ max_results: 1000, include_nested: true, filter_mode: "all" }
```

Loaded from saved config (if user clicked SAVE OPTIONS) or from your `options_defaults`. Keys match your `options[].name` fields. The skeleton handles loading and merging — you just use what you receive.

### Tools

The tools object is your only bridge to the outside world. You do not import libraries for HTTP, logging, or progress — the skeleton provides them.

```javascript
// Logging
tools.logger.info("Processing entity...");
tools.logger.warn("Missing optional field");
tools.logger.error("DNS resolution failed");

// HTTP (rate-limited, retried, logged by skeleton)
const response = await tools.http.get(url, options);
const response = await tools.http.post(url, body, options);
// Returns: { status, headers, body }

// Progress reporting (shown in UI during execution)
tools.progress.update(3, 5, "Processing entity 3 of 5");
```

**What tools does NOT provide:**
- No database access
- No queue access
- No file system write access
- No access to other submodules' data
- No access to configuration outside of `options`

### Return Value

```javascript
{
  results: [
    {
      entity_name: "Company A",
      items: [
        { url: "https://companya.com/about", depth: 1 },
        { url: "https://companya.com/products", depth: 1 }
      ],
      meta: { total_found: 142, filtered: 12, errors: 0 }
    },
    {
      entity_name: "Company B",
      items: [...],
      meta: {...}
    }
  ],
  summary: {
    total_entities: 2,
    total_items: 284,
    errors: []
  }
}
```

**Per-entity grouping required.** The skeleton displays results grouped by entity.

**Summary required.** The skeleton uses it for the status line and card badge.

### Error Handling

**Partial success** — return what worked, include errors:

```javascript
{
  results: [
    { entity_name: "Company A", items: [...], meta: { total_found: 142 } },
    { entity_name: "Bad Domain", items: [], error: "DNS resolution failed", meta: { errors: 1 } }
  ],
  summary: { total_entities: 2, total_items: 142, errors: ["Bad Domain: DNS resolution failed"] }
}
```

**Total failure** — throw an error. The skeleton catches it, marks the run as "failed", and shows the error in the UI.

---

## Custom Options Component (Optional)

If your submodule needs a complex options UI (dynamic fields, conditional sections, visual pickers), you can provide a React component instead of relying on the skeleton's auto-rendered form.

### How It Works

1. Create a React component in your submodule folder (e.g., `OptionsPanel.jsx`)
2. Reference it in your manifest: `"options_component": "./OptionsPanel.jsx"`
3. The skeleton loads your component and renders it inside the Options accordion

### Component Contract

```jsx
export default function OptionsPanel({ options, onChange }) {
  // `options` = current saved values (or defaults on first load)
  // `onChange(newOptions)` = call this whenever the user changes anything
  //   The skeleton tracks dirty state and shows SAVE OPTIONS button

  return (
    <div>
      <label>
        Max Results
        <input
          type="number"
          value={options.max_results}
          onChange={(e) => onChange({ ...options, max_results: Number(e.target.value) })}
        />
      </label>
      {/* Your custom UI here */}
    </div>
  );
}
```

**Rules:**
- Receives `{ options, onChange }` as props
- Must call `onChange(fullOptionsObject)` on every change (not partial — send the complete object)
- No required props — defaults come from `options_defaults` in the manifest
- The skeleton handles: accordion container, dirty tracking, SAVE button, persistence
- Your component handles: the actual form UI

**No options_component?** If your manifest omits `options_component`, the skeleton auto-renders a basic form from your `options[]` array. Fine for simple boolean/number/select fields.

---

## Data Operation Default

Your `data_operation_default` tells the skeleton what your submodule does to the step's working data pool:

| Value | Icon | Meaning | Example |
|-------|------|---------|---------|
| `"add"` | ➕ | Output gets added to the pool | Discovery submodule finding new URLs |
| `"remove"` | ➖ | Output replaces pool with smaller set | Filter submodule removing bad URLs |
| `"transform"` | ＝ | Output replaces pool with same-count different-shape data | Scraper turning URLs into HTML packages |

The user can override this per run. You just set the sensible default.

---

## Output Schema and Render Schema

Your `output_schema` describes what each result item looks like and how it should be displayed. It includes:

- **`display_type`** — How the skeleton renders your data. v1 options:
  - `"table"` — Columnar rows (default). Each field becomes a column header.
  - `"url_list"` — Compact list showing primary URL + entity name. Other fields on row expand.
  - `"content_cards"` — Card layout for content pieces (articles, HTML documents). Shows title, excerpt, status. Used by content-producing steps.
  - `"file_list"` — Filename + size + timestamp. For steps that produce file outputs.
- **Field definitions** — Each field name and type. Used for results column headers.

This matters because:

1. The skeleton uses it to render columns in the Results accordion
2. When your output becomes input for the next step or submodule, the skeleton carries `output_schema` as `render_schema` so the downstream Input accordion renders your data in the same format you produced it

**The skeleton does not reformat your data.** URL lists stay as URL lists. Tables stay as tables. HTML packages stay as HTML previews. Your `output_schema` defines how your output is visualized everywhere it appears downstream.

---

## Cost Levels

| Level | Timeout | Retries | BullMQ Priority | Use When |
|-------|---------|---------|-----------------|----------|
| `cheap` | 5 min | 3 | 1 (highest) | No API calls, fast processing |
| `medium` | 15 min | 2 | 5 | Some API calls, moderate processing |
| `expensive` | 30 min | 1 | 10 (lowest) | Paid APIs, rate-limited, heavy processing |

---

## Full Example: RSS Feed Submodule

### manifest.json

```json
{
  "id": "rss-feeds",
  "name": "RSS Feeds",
  "description": "Parse RSS/Atom feeds for content URLs.",
  "version": "1.0.0",
  "step": 1,
  "category": "news",
  "cost": "cheap",
  "data_operation_default": "add",

  "requires_columns": ["website"],

  "options": [
    {
      "name": "max_items",
      "type": "number",
      "label": "Max feed items",
      "description": "Maximum feed items to process per entity.",
      "default": 50,
      "min": 1,
      "max": 500
    },
    {
      "name": "include_enclosures",
      "type": "boolean",
      "label": "Include media enclosures",
      "description": "Include media enclosure URLs in results.",
      "default": false
    }
  ],

  "options_defaults": {
    "max_items": 50,
    "include_enclosures": false
  },

  "item_key": "url",

  "output_schema": {
    "display_type": "table",
    "url": "string (required)",
    "title": "string",
    "published_at": "string (ISO date)",
    "feed_source": "string"
  }
}
```

### execute.js

```javascript
async function execute(input, options, tools) {
  const results = [];

  for (let i = 0; i < input.entities.length; i++) {
    const entity = input.entities[i];
    tools.progress.update(i + 1, input.entities.length, `Processing ${entity.name}`);

    if (!entity.website) {
      tools.logger.warn(`${entity.name}: no website field, skipping`);
      results.push({
        entity_name: entity.name,
        items: [],
        error: "Missing website field",
        meta: { errors: 1 }
      });
      continue;
    }

    try {
      // Try common feed paths
      const feedUrls = [
        `https://${entity.website}/feed`,
        `https://${entity.website}/rss`,
        `https://${entity.website}/feed.xml`,
      ];

      const items = [];
      for (const feedUrl of feedUrls) {
        const response = await tools.http.get(feedUrl);
        if (response.status === 200) {
          // Parse feed XML, extract items
          const parsed = parseFeed(response.body, options.max_items);
          items.push(...parsed);
          tools.logger.info(`${entity.name}: found ${parsed.length} items at ${feedUrl}`);
          break;
        }
      }

      results.push({
        entity_name: entity.name,
        items: items.map(item => ({
          url: item.link,
          title: item.title,
          published_at: item.pubDate,
          feed_source: entity.website
        })),
        meta: { total_found: items.length, errors: 0 }
      });

    } catch (err) {
      tools.logger.error(`${entity.name}: ${err.message}`);
      results.push({
        entity_name: entity.name,
        items: [],
        error: err.message,
        meta: { errors: 1 }
      });
    }
  }

  const totalItems = results.reduce((sum, r) => sum + r.items.length, 0);
  const errors = results.filter(r => r.error).map(r => `${r.entity_name}: ${r.error}`);

  return {
    results,
    summary: {
      total_entities: input.entities.length,
      total_items: totalItems,
      errors
    }
  };
}

module.exports = execute;
```

After creating this folder and restarting the skeleton, "RSS Feeds" appears in the UI under the News category in Step 1.

---

## What You DON'T Do

- **No database access** — the skeleton handles all persistence
- **No queue management** — the skeleton creates and manages BullMQ jobs
- **No UI rendering** — the skeleton renders Input, Results, and CTA buttons; you only provide an optional Options component
- **No raw HTTP** — use `tools.http` (rate-limited, retried, logged)
- **No imports of skeleton code** — your submodule is isolated in a separate repo
- **No registration** — the skeleton auto-discovers your folder at startup
