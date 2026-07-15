#!/usr/bin/env node
// Cloudinary residue check for the D12 integration test
// (server/tests/storageCloudinary.integration.mjs).
//
// Lists any ZZ_CloudinaryIntegration_* leftovers under pipline/asset/ — expect NONE after the
// test's finally-block cleanup. This is the only guard between a prod-pointed integration run
// and silent Cloudinary/stored_assets pollution, so it ships in the repo, NOT /tmp.
//
// Run (needs live Cloudinary creds): node scripts/cloudinary-residue-check.cjs
// Exit: 0 = clean, 2 = residue found, 1 = misconfig / API error.
const { v2: c } = require('cloudinary');

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME; // NO fallback — see below.
if (!CLOUD_NAME) {
  // A hardcoded default would scan the WRONG account and report a false "clean" — the same
  // silent-salvage failure class the integration test guards. Fail loud instead.
  console.error('CLOUDINARY_CLOUD_NAME is unset — refusing to fall back to a hardcoded cloud.');
  process.exit(1);
}

c.config({
  cloud_name: CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

(async () => {
  const hits = [];
  for (const rt of ['raw', 'image', 'video']) {
    let next;
    do {
      const r = await c.api.resources({
        type: 'upload',
        resource_type: rt,
        prefix: 'pipline/asset/',
        max_results: 100,
        next_cursor: next,
      });
      for (const x of r.resources) {
        if (/zz-cloudinaryintegration/i.test(x.public_id)) hits.push(rt + ':' + x.public_id);
      }
      next = r.next_cursor;
    } while (next);
  }
  console.log('ZZ residue under pipline/asset/:', hits.length, hits);
  if (hits.length) process.exit(2);
})().catch((e) => {
  console.error('cloudinary check error:', e.message);
  process.exit(1);
});
