import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PayloadHttpSandboxBackend, computePayloadRequestHash } from '../src/payload-adapter.js';
import { createPayloadDraftPlan } from '../src/payload-template.js';

const baseUrl = process.env.PAYLOAD_LOCAL_URL || 'http://127.0.0.1:3000';
const email = process.env.PAYLOAD_LOCAL_EMAIL;
const password = process.env.PAYLOAD_LOCAL_PASSWORD;
if (!email || !password) throw new Error('Set PAYLOAD_LOCAL_EMAIL and PAYLOAD_LOCAL_PASSWORD for the local Payload reviewer account');

const origin = new URL(baseUrl);
assert.equal(origin.protocol, 'http:', 'Local smoke test only accepts loopback HTTP');
assert.ok(['127.0.0.1', '[::1]'].includes(origin.hostname), 'Local smoke test only accepts 127.0.0.1 or ::1');
assert.equal(origin.pathname, '/', 'PAYLOAD_LOCAL_URL must be an origin without a path');
assert.equal(origin.username, '');
assert.equal(origin.password, '');
assert.equal(origin.search, '');
assert.equal(origin.hash, '');

const login = await fetch(new URL('/api/users/login', origin), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) throw new Error(`Local Payload login rejected: HTTP ${login.status}`);
const loginResult = await login.json();
assert.ok(loginResult.token, 'Local Payload login must return a bearer token');

const suffix = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
const page = `sitepilot-smoke-${suffix}`;
const route = `/${page}`;
const components = [
  { instanceId: `hero_${suffix}`, registryId: 'payload-hero', name: 'Hero', props: { variant: 'lowImpact' }, source: { repository: 'payloadcms-payload', commit: 'a'.repeat(40), path: 'templates/website/src/heros/LowImpact/index.tsx' } },
  { instanceId: `content_${suffix}`, registryId: 'payload-content', name: 'Content', props: { columns: 1 }, source: { repository: 'payloadcms-payload', commit: 'a'.repeat(40), path: 'templates/website/src/blocks/Content/config.ts' } },
  { instanceId: `cta_${suffix}`, registryId: 'payload-cta', name: 'CTA', props: { links: 0 }, source: { repository: 'payloadcms-payload', commit: 'a'.repeat(40), path: 'templates/website/src/blocks/CallToAction/config.ts' } },
];
const designDraftId = `design_local_${suffix}`;
const designHash = crypto.createHash('sha256').update(JSON.stringify({ page, route, components })).digest('hex');
const designDraft = { id: designDraftId, designHash, pageTree: [{ page, route, components }] };
const pagePlan = { routes: [{ page, route, components: components.map(({ instanceId, props, ...component }) => component) }] };
const plan = createPayloadDraftPlan({
  projectId: 'sitepilot-local-synthetic-smoke',
  strategy: { pageHierarchy: [page], blocks: ['Hero', 'Content', 'CTA'] },
  locales: ['en'],
  designDraft,
  pagePlan,
  contentByPage: {
    [page]: {
      title: 'SitePilot local synthetic sandbox smoke test',
      heroTitle: 'Synthetic Payload draft verification',
      description: 'This unpublished draft contains synthetic CI-style acceptance content only.',
      cta: 'Review synthetic draft',
      claimRefs: ['sitepilot_local_synthetic_smoke'],
    },
  },
});

const candidateId = `candidate_local_${suffix}`;
const candidateHash = crypto.createHash('sha256').update(candidateId).digest('hex');
const expectedCmsSnapshot = 'local_sandbox_smoke';
const requestHash = computePayloadRequestHash({
  candidateId,
  candidateHash,
  expectedCmsSnapshot,
  pageOperations: plan.operations,
  environment: 'sandbox',
  designDraftId,
  designHash,
  designMappings: plan.designMappings,
});
const backend = new PayloadHttpSandboxBackend({
  baseUrl: origin.href,
  token: loginResult.token,
  allowLocalSandbox: true,
});
const receipt = await backend.apply({
  candidateId,
  candidateHash,
  expectedCmsSnapshot,
  operations: plan.operations,
  requestHash,
  designDraftId,
  designHash,
  designMappings: plan.designMappings,
});
assert.equal(receipt.recordRefs.length, 1);

const anonymousRead = await fetch(new URL(`/api/pages?where[slug][equals]=${encodeURIComponent(page)}&draft=true`, origin));
assert.equal(anonymousRead.status, 200);
assert.equal((await anonymousRead.json()).totalDocs, 0, 'Anonymous REST reads must not expose the draft');

console.log(JSON.stringify({
  synthetic: true,
  published: false,
  baseUrl: origin.origin,
  slug: page,
  designDraftId,
  designHash,
  requestHash,
  recordRefs: receipt.recordRefs,
  readbackVerified: true,
  anonymousDraftReadBlocked: true,
}, null, 2));
