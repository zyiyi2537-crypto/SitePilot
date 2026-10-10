import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { getPayload } from 'payload'
import config from './src/payload.config'

// This script is copied to the verified CI template, never exposed as an agent tool.
assert.equal(process.env.CI, '1')
assert.equal(process.env.DATABASE_URL, 'mongodb://127.0.0.1:27017/sitepilot_payload_ci')
assert.ok(process.env.SITEPILOT_CI_PASSWORD)
const plan = JSON.parse(await fs.readFile('./sitepilot-draft-plan.json', 'utf8'))
assert.equal(plan.synthetic, true)
assert.equal(plan.publishAllowed, false)
assert.equal(plan.projectId, 'ci-synthetic-website')
assert.equal(plan.operations.length, 1)
const operation = plan.operations[0]
assert.equal(operation.type, 'upsert_page')
assert.equal(operation.collection, 'pages')
assert.equal(operation.data._status, 'draft')
assert.equal(operation.data.slug, 'sitepilot-ci')
const payload = await getPayload({ config })
try {
  const existing = await payload.find({ collection: 'pages', limit: 1, overrideAccess: true })
  const users = await payload.find({ collection: 'users', limit: 1, overrideAccess: true })
  assert.equal(existing.totalDocs, 0, 'CI database must be empty')
  assert.equal(users.totalDocs, 0, 'CI user collection must be empty')
  await payload.create({
    collection: 'users',
    overrideAccess: true,
    data: { email: 'sitepilot-ci@example.invalid', password: process.env.SITEPILOT_CI_PASSWORD, name: 'CI only reviewer' },
  })
  const page = await payload.create({
    collection: 'pages', draft: true, overrideAccess: true,
    context: { disableRevalidate: true }, data: operation.data,
  })
  const draft = await payload.findByID({ collection: 'pages', id: page.id, draft: true, overrideAccess: true })
  assert.equal(draft._status, 'draft')
  assert.equal(draft.slug, operation.data.slug)
  assert.equal(draft.title, operation.data.title)
  assert.deepEqual(draft.hero?.richText, operation.data.hero.richText)
  assert.equal(draft.layout?.length, operation.data.layout.length)
  const visible = await payload.find({
    collection: 'pages', overrideAccess: false, draft: false,
    where: { slug: { equals: operation.data.slug } },
  })
  assert.equal(visible.totalDocs, 0, 'Draft must not be publicly visible')
  await fs.writeFile('./sitepilot-cms-receipt.json', JSON.stringify({
    synthetic: true, sourceCommit: plan.sourceCommit, projectId: plan.projectId,
    recordId: page.id, slug: draft.slug, status: draft._status,
    claimRefs: plan.claimRefs, published: false, database: 'ephemeral-ci-only',
  }, null, 2))
  console.log('Verified CMS draft persisted and excluded from public reads.')
} finally {
  await payload.destroy()
}
