import 'dotenv/config'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const profileDir = process.env.SKEDDA_PROFILE_DIR || path.join(rootDir, '.skedda-profile')
const viewMapId = process.env.SKEDDA_VIEW_MAP_ID || '0c5eaf6404d2464aa4df03abe4cad93c'
const browserDebugPort = Number(process.env.SKEDDA_BROWSER_DEBUG_PORT || 9223)

const url = new URL('https://zeekr.skedda.com/booking')
url.searchParams.set('viewdate', process.env.SKEDDA_LOGIN_VIEW_DATE || todayAmsterdam())
url.searchParams.set('viewend', process.env.SKEDDA_LOGIN_VIEW_END || addDays(todayAmsterdam(), 41))
url.searchParams.set('viewmapid', viewMapId)

const browser = await openBrowser()
const context = browser.contexts()[0] || await browser.newContext({ viewport: { width: 1440, height: 950 } })
const page = context.pages().find((candidate) => !candidate.url().startsWith('devtools://')) || await context.newPage()
await page.goto(url.toString(), { waitUntil: 'domcontentloaded' })

console.log('')
console.log('A Skedda browser window is open for SSO login.')
console.log('Finish login in that browser. This runner exits after it sees the Zeekr booking page.')
console.log('The browser stays open so the daily booking script can reuse the same session.')
console.log('')

const deadline = Date.now() + Number(process.env.SKEDDA_LOGIN_TIMEOUT_MS || 10 * 60 * 1000)
while (Date.now() < deadline) {
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
  if (await isBookingPage(page)) break
  await page.waitForTimeout(2_000)
}

await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
await page.waitForTimeout(Number(process.env.SKEDDA_LOGIN_SAVE_DELAY_MS || 8_000))
const title = await page.title().catch(() => '')

if (!(await isBookingPage(page))) {
  console.error('Skedda booking page was not reached before the login timeout. Run this command again and complete SSO in the browser.')
  console.error(`Current URL: ${page.url()}`)
  console.error(`Current title: ${title}`)
  process.exit(1)
}

console.log('Skedda login state saved to:')
console.log(profileDir)
const cookies = await context.cookies(['https://zeekr.skedda.com', 'https://app.skedda.com'])
console.log(`Saved ${cookies.length} Skedda-domain cookies.`)
console.log(`Browser left open on debugging port ${browserDebugPort}.`)
process.exit(0)

async function openBrowser() {
  const endpoint = `http://127.0.0.1:${browserDebugPort}`
  const existingBrowser = await chromium.connectOverCDP(endpoint).catch(() => null)
  if (existingBrowser) return existingBrowser

  const child = spawn(chromium.executablePath(), [
    `--remote-debugging-port=${browserDebugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-popup-blocking',
    '--start-maximized',
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  await waitForCdpEndpoint(endpoint)
  return chromium.connectOverCDP(endpoint)
}

async function waitForCdpEndpoint(endpoint) {
  const deadline = Date.now() + Number(process.env.SKEDDA_CDP_START_TIMEOUT_MS || 30_000)
  while (Date.now() < deadline) {
    const ok = await fetch(`${endpoint}/json/version`).then((response) => response.ok).catch(() => false)
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Chrome did not expose CDP at ${endpoint}.`)
}

async function isBookingPage(page) {
  const pageUrl = page.url()
  const pageTitle = await page.title().catch(() => '')
  const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')
  return pageUrl.startsWith('https://zeekr.skedda.com/booking')
    && (pageTitle.includes('Booking System') || bodyText.includes('USER MODE') || bodyText.includes('View: Map') || bodyText.includes('Map'))
    && !bodyText.includes('Log in with SSO')
}

function todayAmsterdam() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.SKEDDA_TIMEZONE || 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${lookup.year}-${lookup.month}-${lookup.day}`
}

function addDays(yyyyMmDd, days) {
  const [year, month, day] = yyyyMmDd.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days, 12))
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.SKEDDA_TIMEZONE || 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${lookup.year}-${lookup.month}-${lookup.day}`
}
