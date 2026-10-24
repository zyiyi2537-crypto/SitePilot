import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { chromium, expect, type APIResponse } from '@playwright/test'
import { PayloadHttpSandboxBackend, computePayloadRequestHash } from './sitepilot-payload-adapter.mjs'

assert.equal(process.env.CI, '1')
assert.ok(process.env.SITEPILOT_CI_PASSWORD)
assert.ok(process.env.PREVIEW_SECRET)
const baseURL = 'http://127.0.0.1:3000'
const plan = JSON.parse(await fs.readFile('./sitepilot-draft-plan.json', 'utf8'))
const designPage = plan.designMappings?.pages?.find((item: { page: string }) => item.page === 'sitepilot-ci')
assert.ok(designPage, 'preview plan must carry the synthetic DesignDraft mapping')
assert.deepEqual(designPage.components.map((component: { name: string }) => component.name), ['Hero', 'Content', 'CTA'])
const httpPlan = plan.httpDraft
assert.equal(httpPlan?.designMappings?.designDraftId, 'design_ci_http')
assert.equal(httpPlan?.designMappings?.pages?.[0]?.route, '/sitepilot-http-ci')
const serviceLogin = await fetch(`${baseURL}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'sitepilot-ci@example.invalid', password: process.env.SITEPILOT_CI_PASSWORD }),
})
assert.equal(serviceLogin.status, 200)
const serviceAuth = await serviceLogin.json() as { token?: string }
assert.ok(serviceAuth.token, 'Payload login must provide a bearer token for the sandbox adapter')
const httpCandidate = { id: 'candidate_ci_http', hash: 'c'.repeat(64) }
const httpOperation = structuredClone(httpPlan.operations[0])
const httpDesignMappings = httpPlan.designMappings
const expectedCmsSnapshot = 'ci_empty_snapshot'
const requestHash = computePayloadRequestHash({
  candidateId: httpCandidate.id,
  candidateHash: httpCandidate.hash,
  expectedCmsSnapshot,
  pageOperations: [httpOperation],
  environment: 'sandbox',
  designDraftId: httpDesignMappings.designDraftId,
  designHash: httpDesignMappings.designHash,
  designMappings: httpDesignMappings,
})
const sandboxOrigin = 'https://payload-sandbox.invalid'
const sandboxRequests: { url: string; method: string; headers: HeadersInit }[] = []
const sandboxBackend = new PayloadHttpSandboxBackend({
  baseUrl: sandboxOrigin,
  token: serviceAuth.token,
  fetchImpl: async (url, options) => {
    const target = new URL(url)
    assert.equal(target.origin, sandboxOrigin)
    sandboxRequests.push({ url: target.href, method: options.method, headers: options.headers })
    return fetch(new URL(`${target.pathname}${target.search}`, baseURL), options)
  },
})
const sandboxReceipt = await sandboxBackend.apply({
  candidateId: httpCandidate.id,
  candidateHash: httpCandidate.hash,
  expectedCmsSnapshot,
  operations: [httpOperation],
  requestHash,
  designDraftId: httpDesignMappings.designDraftId,
  designHash: httpDesignMappings.designHash,
  designMappings: httpDesignMappings,
})
assert.equal(sandboxReceipt.recordRefs.length, 1)
assert.equal(sandboxRequests.length, 2, 'HTTP sandbox adapter must write and read back the Payload draft')
assert.deepEqual(sandboxRequests.map((item) => item.method), ['POST', 'GET'])
assert.equal(new Headers(sandboxRequests[0].headers).get('x-sitepilot-design-hash'), httpDesignMappings.designHash)
assert.equal(new Headers(sandboxRequests[0].headers).get('x-sitepilot-design-mapping-hash'), crypto.createHash('sha256').update(JSON.stringify(httpDesignMappings)).digest('hex'))
assert.equal(new Headers(sandboxRequests[0].headers).get('idempotency-key'), `${requestHash}:0`)
await fs.writeFile('./sitepilot-http-cms-receipt.json', JSON.stringify({
  synthetic: true, candidateId: httpCandidate.id, candidateHash: httpCandidate.hash,
  designDraftId: httpDesignMappings.designDraftId, designHash: httpDesignMappings.designHash,
  requestHash, recordRefs: sandboxReceipt.recordRefs, readbackVerified: true,
}, null, 2))
const browser = await chromium.launch()
const checks: string[] = []
try {
  const anonymous = await browser.newContext({ baseURL })
  for (const slug of ['sitepilot-ci', 'sitepilot-http-ci']) {
    const publicDraft = await anonymous.request.get(`/api/pages?where[slug][equals]=${slug}&draft=true`)
    assert.equal(publicDraft.status(), 200)
    assert.equal((await publicDraft.json()).totalDocs, 0)
  }
  checks.push('anonymous REST requests cannot read either draft')
  const denied = await anonymous.request.get(`/next/preview?path=/sitepilot-ci&previewSecret=${encodeURIComponent(process.env.PREVIEW_SECRET!)}`, { maxRedirects: 0 })
  assert.equal(denied.status(), 403)
  checks.push('preview secret without reviewer login is denied')
  const page = await anonymous.newPage()
  const publicPage = await page.goto(`${baseURL}/sitepilot-ci`)
  assert.equal(publicPage?.status(), 404)
  const publicHttpPage = await page.goto(`${baseURL}/sitepilot-http-ci`)
  assert.equal(publicHttpPage?.status(), 404)
  checks.push('anonymous website route returns 404 for draft')
  await anonymous.close()

  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 375, height: 812 }],
  ] as const) {
    const context = await browser.newContext({ baseURL, viewport })
    const login: APIResponse = await context.request.post('/api/users/login', { data: {
      email: 'sitepilot-ci@example.invalid', password: process.env.SITEPILOT_CI_PASSWORD,
    } })
    assert.equal(login.status(), 200)
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const preview: APIResponse = await context.request.get(`/next/preview?path=/sitepilot-ci&previewSecret=${encodeURIComponent(process.env.PREVIEW_SECRET!)}`, { maxRedirects: 0 })
    assert.equal(preview.status(), 307)
    const response = await page.goto(`${baseURL}/sitepilot-ci`)
    assert.equal(response?.status(), 200)
    const rendered = await page.locator('body').innerText()
    const renderedOrder = [
      'SitePilot CMS draft preview',
      'Synthetic content generated by the SitePilot draft planner for CI acceptance only.',
      'Review this synthetic website draft',
    ].map((text) => rendered.indexOf(text))
    assert.ok(renderedOrder.every((index) => index >= 0), `${name} must render every mapped component`)
    assert.ok(renderedOrder[0] < renderedOrder[1] && renderedOrder[1] < renderedOrder[2], `${name} rendered component order must match DesignDraft mapping`)
    await expect(page.getByRole('heading', { name: 'SitePilot CMS draft preview', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Review this synthetic website draft', exact: true })).toBeVisible()
    await expect(page.locator('article')).toContainText('Synthetic content generated by the SitePilot draft planner')
    await expect(page).toHaveTitle('SitePilot synthetic acceptance website | Payload Website Template')
    await page.waitForTimeout(1000)
    assert.deepEqual(errors, [], `${name} client errors`)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    assert.equal(overflow, false, `${name} horizontal overflow`)
    await page.screenshot({ path: `sitepilot-${name}.png`, fullPage: true })
    checks.push(`${name}: authenticated draft renders CMS hero, content, CTA and SEO without client errors or overflow`)
    const httpPreview = await context.request.get(`/next/preview?path=/sitepilot-http-ci&previewSecret=${encodeURIComponent(process.env.PREVIEW_SECRET!)}`, { maxRedirects: 0 })
    assert.equal(httpPreview.status(), 307)
    const httpPage = await context.newPage()
    const httpResponse = await httpPage.goto(`${baseURL}/sitepilot-http-ci`)
    assert.equal(httpResponse?.status(), 200)
    await expect(httpPage.getByRole('heading', { name: 'SitePilot CMS draft preview', exact: true })).toBeVisible()
    await expect(httpPage.locator('article')).toContainText('Synthetic content generated by the SitePilot draft planner')
    await httpPage.close()
    await context.close()
  }
  await fs.writeFile('./sitepilot-preview-report.json', JSON.stringify({
    synthetic: true, preview: 'ephemeral GitHub runner only', checks,
    limitations: ['compile mode only; full type check and production route generation pending', 'no customer input, CodeAtlas retrieval, form or multilingual acceptance in this fixture'],
  }, null, 2))
  console.log(checks.join('\n'))
} finally {
  await browser.close()
}
