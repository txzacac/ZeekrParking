import 'dotenv/config'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nodemailer from 'nodemailer'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const profileDir = process.env.SKEDDA_PROFILE_DIR || path.join(rootDir, '.skedda-profile')
const logDir = path.join(rootDir, 'logs', 'skedda')

const venueBaseUrl = 'https://zeekr.skedda.com/booking'
const viewMapId = process.env.SKEDDA_VIEW_MAP_ID || '0c5eaf6404d2464aa4df03abe4cad93c'
const timezone = process.env.SKEDDA_TIMEZONE || 'Europe/Amsterdam'
const targetStart = process.env.SKEDDA_START_TIME || '08:00'
const targetEnd = process.env.SKEDDA_END_TIME || '18:00'
const carMake = process.env.SKEDDA_CAR_MAKE || 'tesla'
const carModel = process.env.SKEDDA_CAR_MODEL || 'model y'
const licensePlate = process.env.SKEDDA_LICENSE_PLATE || 'GGV-99-J'
const preferredSpaces = (process.env.SKEDDA_PREFERRED_SPACES || 'Z15,Z16,Z17,Z8,Z9,Z11,Z12,Z13,Z14')
  .split(',')
  .map((space) => space.trim().toUpperCase())
  .filter(Boolean)
const preferredSpacePrefixes = (process.env.SKEDDA_PREFERRED_SPACE_PREFIXES || 'Z')
  .split(',')
  .map((prefix) => prefix.trim().toUpperCase())
  .filter(Boolean)
const preferredRectIndices = (process.env.SKEDDA_PREFERRED_RECT_INDICES || '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value))
const headless = (process.env.SKEDDA_HEADLESS || 'false').toLowerCase() !== 'false'
const dryRun = ['1', 'true', 'yes'].includes((process.env.SKEDDA_DRY_RUN || '').toLowerCase())
const keepBrowserOpen = ['1', 'true', 'yes'].includes((process.env.SKEDDA_KEEP_BROWSER_OPEN || 'true').toLowerCase())
const browserDebugPort = Number(process.env.SKEDDA_BROWSER_DEBUG_PORT || 9223)

await fs.mkdir(logDir, { recursive: true })
const runStamp = stampForFilename(new Date())
const logPath = path.join(logDir, `${runStamp}.log`)

const target = process.env.SKEDDA_TARGET_DATE
  ? { date: process.env.SKEDDA_TARGET_DATE, skipped: false, reason: 'SKEDDA_TARGET_DATE override' }
  : nextBookingTarget(new Date())

if (target.skipped) {
  await finish({
    status: 'skipped',
    subject: 'Skedda skipped',
    lines: [
      `Skipped: ${target.reason}`,
      `Timezone: ${timezone}`,
      `Run time: ${new Date().toISOString()}`,
    ],
  })
  process.exit(0)
}

const browserSession = await openBrowserSession()
const { context, page, connectedToExistingBrowser } = browserSession
let screenshotPath = null
let shouldKeepBrowserOpen = false

try {
  page.setDefaultTimeout(Number(process.env.SKEDDA_TIMEOUT_MS || 20_000))

  const bookingUrl = buildBookingUrl(target.date)
  await log(`Opening ${bookingUrl}`)
  await page.goto(bookingUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})

  if (await isLoginPage(page)) {
    const recovered = await trySsoLogin(page)
    if (!recovered) {
    screenshotPath = await saveScreenshot(page, 'login-required')
    await finish({
      status: 'login-required',
      subject: 'Skedda login required',
      attachments: screenshotPath ? [screenshotPath] : [],
      lines: [
        `Skedda redirected to login before booking ${target.date}.`,
        'Run: npm run skedda:login',
        `Screenshot: ${screenshotPath}`,
        ],
      })
      process.exitCode = 2
    }
  }

  if (!process.exitCode) {
    await dismissUsagePrompt(page)
    await ensureMapView(page)
    await setTimelineStart(page, targetStart)
  } else {
    await log(`Stopping before booking because exitCode=${process.exitCode}.`)
  }

  if (!process.exitCode) {
    const result = await attemptPriorityBookings(page, bookingUrl)
    screenshotPath = result.screenshotPath
    await finish({
      status: result.status,
      subject: result.subject,
      attachments: screenshotPath ? [screenshotPath] : [],
      lines: result.lines,
    })
    shouldKeepBrowserOpen = result.confirmClicked
  } else {
    await log('Booking flow skipped.')
  }
} catch (error) {
  screenshotPath = screenshotPath || await saveScreenshot(page, 'error').catch(() => null)
  await finish({
    status: 'error',
    subject: 'Skedda error',
    attachments: screenshotPath ? [screenshotPath] : [],
    lines: [
      `Error while booking ${target.date} ${targetStart}-${targetEnd}:`,
      error?.stack || String(error),
      screenshotPath ? `Screenshot: ${screenshotPath}` : '',
    ].filter(Boolean),
  })
  process.exitCode = 1
} finally {
  if (connectedToExistingBrowser) {
    await log('Connected to an existing Skedda browser; leaving that browser open and exiting this runner.')
    process.exit(process.exitCode || 0)
  } else if (keepBrowserOpen && shouldKeepBrowserOpen) {
    await log('SKEDDA_KEEP_BROWSER_OPEN=true; leaving browser open to preserve the SSO session.')
    await new Promise(() => {})
  } else {
    await context.close().catch(() => {})
  }
}

function buildBookingUrl(date) {
  const viewEnd = addDays(date, Number(process.env.SKEDDA_VIEW_END_DAYS || 41))
  const params = new URLSearchParams({
    nbstart: `${date}T${targetStart}:00`,
    nbend: `${date}T${targetEnd}:00`,
    viewdate: date,
    viewend: viewEnd,
    viewmapid: viewMapId,
  })
  return `${venueBaseUrl}?${params.toString()}`
}

async function openBrowserSession() {
  const endpoint = `http://127.0.0.1:${browserDebugPort}`
  const browser = await chromium.connectOverCDP(endpoint).catch(() => null)
  if (browser) {
    await log(`Connected to existing Skedda browser at ${endpoint}.`)
    const context = browser.contexts()[0] || await browser.newContext({ viewport: { width: 1440, height: 950 } })
    const page = await context.newPage()
    return { context, page, connectedToExistingBrowser: true }
  }

  await log(`No existing Skedda browser found at ${endpoint}; launching a detached Chrome browser.`)
  const args = [
    `--remote-debugging-port=${browserDebugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-popup-blocking',
    '--start-maximized',
  ]
  if (headless) args.push('--headless=new')

  const child = spawn(chromium.executablePath(), args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  await waitForCdpEndpoint(endpoint)

  const launchedBrowser = await chromium.connectOverCDP(endpoint)
  const context = launchedBrowser.contexts()[0] || await launchedBrowser.newContext({ viewport: { width: 1440, height: 950 } })
  const page = await context.newPage()
  return { context, page, connectedToExistingBrowser: true }
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

function nextBookingTarget(now) {
  const today = datePartsInTimezone(now)
  const dow = today.weekday
  if (dow === 5) return { skipped: true, reason: 'Friday run would target Saturday.' }
  if (dow === 6) return { skipped: true, reason: 'Saturday run would target Sunday.' }
  return { skipped: false, date: addDays(today.date, 1) }
}

function datePartsInTimezone(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date)
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(lookup.weekday)
  return {
    date: `${lookup.year}-${lookup.month}-${lookup.day}`,
    weekday,
  }
}

function addDays(yyyyMmDd, days) {
  const [year, month, day] = yyyyMmDd.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days, 12))
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${lookup.year}-${lookup.month}-${lookup.day}`
}

async function isLoginPage(page) {
  const url = page.url()
  const title = await page.title().catch(() => '')
  const text = await visibleText(page).catch(() => '')
  return url.includes('/account/login') || title.includes('Log in') || text.includes('Log in with SSO')
}

async function isBookingPage(page) {
  const url = page.url()
  const title = await page.title().catch(() => '')
  const text = await visibleText(page).catch(() => '')
  return url.startsWith('https://zeekr.skedda.com/booking')
    && (title.includes('Booking System') || text.includes('USER MODE') || text.includes('View: Map'))
}

async function trySsoLogin(page) {
  const sso = page.getByText('Log in with SSO', { exact: true })
  if (!(await sso.count())) return false

  await log('Login page detected; trying SSO recovery.')
  await sso.first().click()
  const deadline = Date.now() + Number(process.env.SKEDDA_SSO_TIMEOUT_MS || 90_000)
  while (Date.now() < deadline) {
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
    if (await isBookingPage(page)) {
      await log('SSO recovery reached the booking page.')
      return true
    }
    await page.waitForTimeout(2_000)
  }
  return false
}

async function dismissUsagePrompt(page) {
  const decline = page.getByRole('button', { name: 'Decline', exact: true })
  if (await decline.count()) {
    await decline.first().click().catch(() => {})
    await page.waitForTimeout(500)
  }
}

async function ensureMapView(page) {
  const text = await visibleText(page)
  if (text.includes('View: Map')) return
  const viewButton = page.getByRole('button', { name: /^View:/ })
  if (await viewButton.count()) {
    await viewButton.first().click()
    await page.getByRole('button', { name: 'Map', exact: true }).first().click()
    await page.waitForTimeout(1_000)
  }
}

async function setTimelineStart(page, time) {
  const currentTimeButton = page.getByRole('button', { name: /^\d{2}:\d{2}(\s|$)/ })
  if (await currentTimeButton.count()) {
    const currentText = await currentTimeButton.first().innerText().catch(() => '')
    if (currentText.trim().startsWith(time)) return

    await currentTimeButton.first().click().catch(() => {})
    await page.waitForTimeout(500)
    const option = page.getByRole('button', { name: time, exact: true })
    if (await option.count()) {
      await option.last().click()
      await page.waitForTimeout(800)
      return
    }
  }

  await page.locator('input[type="range"]').first().evaluate((input, target) => {
    const [hours, minutes] = target.split(':').map(Number)
    const targetMinutes = hours * 60 + minutes
    const min = Number(input.min || 0)
    const max = Number(input.max || 24 * 60)
    const step = Number(input.step || 15)
    const nextValue = Math.min(max, Math.max(min, Math.round(targetMinutes / step) * step))
    input.value = String(nextValue)
    input.setAttribute('aria-label', target)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, time).catch(() => {})
  await page.waitForTimeout(800)
}

async function openFirstBookableGreenSpace(page) {
  const selector = 'rect[role="button"], path[role="button"], polygon[role="button"], circle[role="button"], g[role="button"], [role="button"] rect'
  const rectCandidates = await page.locator(selector).evaluateAll((rects) => {
    function parseRgb(value) {
      const match = String(value).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
      return match ? match.slice(1, 4).map(Number) : null
    }
    function isGreenishColor(value) {
      const rgb = parseRgb(value)
      return Boolean(rgb && rgb[1] >= 110 && rgb[1] > rgb[0] + 15 && rgb[1] > rgb[2] + 5)
    }
    function elementColors(el) {
      const nodes = [el, el.parentElement, ...Array.from(el.querySelectorAll?.('*') || []).slice(0, 10)].filter(Boolean)
      return nodes.flatMap((node) => {
        const style = getComputedStyle(node)
        return [style.fill, style.stroke, style.backgroundColor, node.getAttribute('fill'), node.getAttribute('stroke'), node.getAttribute('class')]
      }).filter(Boolean)
    }
    function centerPointColor(el) {
      const box = el.getBoundingClientRect()
      const cx = box.left + box.width / 2
      const cy = box.top + box.height / 2
      const atPoint = document.elementFromPoint(cx, cy)
      if (!atPoint) return []
      const style = getComputedStyle(atPoint)
      return [style.fill, style.stroke, style.backgroundColor, atPoint.getAttribute('class')].filter(Boolean)
    }
    function isGreenish(el) {
      const colors = [...elementColors(el), ...centerPointColor(el)]
      const haystack = colors.join(' ').toLowerCase()
      if (haystack.includes('green') || haystack.includes('available')) return true
      return colors.some(isGreenishColor)
    }
    return rects
      .map((rect, index) => {
        const box = rect.getBoundingClientRect()
        const style = getComputedStyle(rect)
        return {
          index,
          fill: style.fill,
          stroke: style.stroke,
          className: rect.getAttribute('class') || '',
          visible: box.width > 0 && box.height > 0,
          green: isGreenish(rect),
        }
      })
      .filter((rect) => rect.visible)
  })

  const greenRects = rectCandidates.filter((rect) => rect.green)
  if (!greenRects.length) {
    await log('No green clickable parking spaces detected by color; falling back to visible clickable spaces.')
  }

  const candidates = greenRects.length ? greenRects : sortByPreferredRectIndices(rectCandidates)
  if (!candidates.length) {
    throw new Error('No clickable parking spaces found on the map.')
  }

  let firstBookable = null
  for (const rect of candidates) {
    await page.locator(selector).nth(rect.index).click()
    await page.waitForTimeout(1_200)
    const text = await visibleText(page)
    const name = extractSpaceName(text)
    if (text.includes('Book for') || text.includes('Other available times')) {
      const bookable = { ...rect, name }
      if (!firstBookable) firstBookable = bookable
      if (isPreferredSpace(name)) return bookable
    }
  }

  throw new Error(`Found ${candidates.length} clickable spaces, but no ${preferredSpacePrefixes.join('/')} space opened a booking popover.`)
}

async function attemptPriorityBookings(page, bookingUrl) {
  const candidates = await findBookableSpaceCandidates(page, bookingUrl)
  if (!candidates.length) {
    throw new Error(`No bookable spaces found for priority list: ${preferredSpaces.join(', ')}`)
  }

  const attempts = []
  let lastScreenshotPath = null
  let lastText = ''

  for (const candidate of candidates) {
    await log(`Trying ${candidate.name} by clicking green dot at ${Math.round(candidate.x)},${Math.round(candidate.y)}.`)
    await prepareBookingMap(page, bookingUrl)
    await clickSpaceCandidate(page, candidate)
    await page.waitForTimeout(1_200)
    await clickBookForStart(page, targetStart)
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(1_000)
    await setEndTime(page, targetEnd)
    await fillVehicleDetails(page)

    const beforeConfirmText = await visibleText(page)
    if (!beforeConfirmText.includes('Confirm booking')) {
      attempts.push(`${candidate.name}: could not reach Confirm booking`)
      await cancelDraftBooking(page)
      continue
    }

    if (dryRun) {
      lastScreenshotPath = await saveScreenshot(page, 'dry-run-ready')
      return {
        status: 'dry-run',
        subject: 'Skedda dry run ready',
        screenshotPath: lastScreenshotPath,
        confirmClicked: false,
        lines: [
          `Dry run reached Confirm booking for ${target.date} ${targetStart}-${targetEnd}.`,
          `Space: ${candidate.name}`,
          `Priority order: ${preferredSpaces.join(', ')}`,
          `Screenshot: ${lastScreenshotPath}`,
        ],
      }
    }

    await clickUniqueButton(page, 'Confirm booking')
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await waitForPostConfirmMessage(page, beforeConfirmText)

    lastText = await visibleText(page)
    lastScreenshotPath = await savePostConfirmScreenshot(page, `after-confirm-${candidate.name}`)
    const outcome = classifyOutcome(lastText)
    attempts.push(`${candidate.name}: ${outcome.message}`)

    if (outcome.success) {
      return {
        status: outcome.status,
        subject: `Skedda ${outcome.subject}`,
        screenshotPath: lastScreenshotPath,
        confirmClicked: true,
        lines: [
          `Clicked Confirm booking for ${target.date} ${targetStart}-${targetEnd}.`,
          `Successful space: ${candidate.name}`,
          `Outcome: ${outcome.message}`,
          `Attempts: ${attempts.join(' | ')}`,
          `Screenshot: ${lastScreenshotPath}`,
          '',
          clipText(lastText, 1800),
        ],
      }
    }

    await log(`${candidate.name} did not succeed; trying next priority space.`)
    await cancelDraftBooking(page)
  }

  return {
    status: 'confirm-clicked-no-success',
    subject: 'Skedda confirm clicked, no success',
    screenshotPath: lastScreenshotPath,
    confirmClicked: true,
    lines: [
      `Clicked Confirm booking for ${target.date} ${targetStart}-${targetEnd}, but no priority space produced the success popup.`,
      `Priority order: ${preferredSpaces.join(', ')}`,
      `Attempts: ${attempts.join(' | ')}`,
      lastScreenshotPath ? `Screenshot: ${lastScreenshotPath}` : '',
      '',
      clipText(lastText, 1800),
    ].filter(Boolean),
  }
}

async function findBookableSpaceCandidates(page, bookingUrl) {
  await prepareBookingMap(page, bookingUrl)
  const mapped = await mapPreferredSpacesFromMapGeometry(page)
  for (const candidate of mapped) {
    await log(`Mapped priority space ${candidate.name} to green dot at ${Math.round(candidate.x)},${Math.round(candidate.y)}.`)
  }
  return mapped
}

async function mapPreferredSpacesFromMapGeometry(page) {
  return page.evaluate(({ spaces }) => {
    function parseRgb(value) {
      const match = String(value).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
      return match ? match.slice(1, 4).map(Number) : null
    }
    function isZeekrRed(value) {
      const rgb = parseRgb(value)
      return Boolean(rgb && rgb[0] > 170 && rgb[0] < 230 && rgb[1] > 30 && rgb[1] < 90 && rgb[2] < 40)
    }
    function isAvailableGreen(value) {
      const rgb = parseRgb(value)
      return Boolean(rgb && rgb[1] > 140 && rgb[0] < 80 && rgb[2] > 80 && rgb[2] < 190)
    }
    function rectOf(el) {
      const rect = el.getBoundingClientRect()
      return {
        el,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      }
    }

    const nodes = Array.from(document.querySelectorAll('*'))
    const redRects = nodes
      .filter((el) => el.tagName.toLowerCase() === 'rect')
      .map((el) => {
        const box = rectOf(el)
        return { ...box, fill: getComputedStyle(el).fill }
      })
      .filter((box) => box.width > 60 && box.width < 140 && box.height > 140 && box.height < 240 && isZeekrRed(box.fill))

    const topRow = redRects
      .filter((box) => box.y < 330)
      .sort((a, b) => a.x - b.x)
      .map((box, index) => ({ ...box, name: `Z${index + 8}` }))

    const bottomRow = redRects
      .filter((box) => box.y >= 330)
      .sort((a, b) => a.x - b.x)
      .map((box, index) => ({ ...box, name: `Z${index + 15}` }))

    const spacesByName = new Map([...topRow, ...bottomRow].map((space) => [space.name, space]))
    const greenDots = nodes
      .map((el) => {
        const box = rectOf(el)
        const style = getComputedStyle(el)
        return { ...box, fill: style.fill, stroke: style.stroke }
      })
      .filter((box) => box.width > 8 && box.width < 50 && box.height > 8 && box.height < 50
        && (isAvailableGreen(box.fill) || isAvailableGreen(box.stroke)))

    return spaces.map((name) => {
      const space = spacesByName.get(name)
      if (!space) return null
      const dot = greenDots
        .filter((candidate) => candidate.x >= space.left - 5 && candidate.x <= space.right + 5
          && candidate.y >= space.top - 5 && candidate.y <= space.bottom + 5)
        .sort((a, b) => Math.hypot(a.x - space.x, a.y - space.y) - Math.hypot(b.x - space.x, b.y - space.y))[0]
      return dot ? { name, x: dot.x, y: dot.y } : null
    }).filter(Boolean)
  }, { spaces: preferredSpaces })
}

async function prepareBookingMap(page, bookingUrl) {
  await page.goto(bookingUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await dismissUsagePrompt(page)
  await ensureMapView(page)
  await setTimelineStart(page, targetStart)
}

async function clickSpaceCandidate(page, candidate) {
  if (Number.isFinite(candidate.x) && Number.isFinite(candidate.y)) {
    await page.mouse.click(candidate.x, candidate.y)
    return
  }
  if (Number.isInteger(candidate.index)) {
    await page.locator(spaceSelector()).nth(candidate.index).click()
    return
  }
  throw new Error(`No clickable coordinate for ${candidate.name}.`)
}

async function cancelDraftBooking(page) {
  const cancel = page.getByRole('button', { name: 'Cancel booking', exact: true })
  if (await cancel.count()) {
    await cancel.first().click().catch(() => {})
    await page.waitForTimeout(800)
  }
}

function isPreferredSpace(name) {
  if (!name) return false
  const upperName = name.toUpperCase()
  return preferredSpacePrefixes.some((prefix) => upperName.startsWith(prefix))
}

function spaceSelector() {
  return 'rect[role="button"], path[role="button"], polygon[role="button"], circle[role="button"], g[role="button"], [role="button"] rect'
}

function sortByPreferredRectIndices(candidates) {
  return [...candidates].sort((a, b) => {
    const aPreferred = preferredRectIndices.includes(a.index)
    const bPreferred = preferredRectIndices.includes(b.index)
    if (aPreferred !== bPreferred) return aPreferred ? -1 : 1
    return a.index - b.index
  })
}

async function clickBookForStart(page, time) {
  const text = await visibleText(page)
  if (text.includes('New booking') && (text.includes(`From ${time}`) || page.url().includes(`nbstart=`))) {
    return
  }

  const preferred = page.getByRole('button', { name: `Book for ${time}`, exact: true })
  if (await preferred.count()) {
    await preferred.first().click()
    return
  }

  const startOption = page.getByRole('button', { name: time, exact: true })
  if (await startOption.count()) {
    await startOption.last().click()
    await page.waitForTimeout(800)
  }

  const anyBook = page.getByRole('button', { name: /^Book for / })
  if (await anyBook.count()) {
    await anyBook.first().click()
    return
  }

  await page.waitForTimeout(2_000)
  const settledText = await visibleText(page)
  if (settledText.includes('New booking') && (settledText.includes(`From ${time}`) || page.url().includes('nbstart='))) {
    return
  }

  throw new Error(`Could not find a Book for ${time} button.`)
}

async function setEndTime(page, time) {
  const text = await visibleText(page)
  const normalized = normalizeText(text)
  if (normalized.includes(`to ${time}`) || normalized.includes(`${targetStart}-${time}`)) return

  const endButton = page.getByRole('button', { name: /^to / })
  if (!(await endButton.count())) {
    throw new Error('Could not find end-time button.')
  }

  await endButton.first().click()
  await page.waitForTimeout(500)

  const option = page.getByRole('button', { name: time, exact: true })
  const count = await option.count()
  if (!count) throw new Error(`Could not find end-time option ${time}.`)
  await option.nth(count - 1).click()
  await page.waitForTimeout(1_000)
}

async function fillVehicleDetails(page) {
  const inputs = page.locator('input:not([type="hidden"]):not([type="range"]):visible')
  const count = await inputs.count()
  if (count < 4) {
    throw new Error(`Expected title plus three vehicle fields, found ${count} visible text inputs.`)
  }

  await inputs.nth(0).fill('')
  await inputs.nth(1).fill(carMake)
  await inputs.nth(2).fill(carModel)
  await inputs.nth(3).fill(licensePlate)
}

async function clickUniqueButton(page, name) {
  const button = page.getByRole('button', { name, exact: true })
  const count = await button.count()
  if (!count) throw new Error(`Button not found: ${name}`)
  await button.first().click()
}

async function waitForPostConfirmMessage(page, beforeText) {
  const messageSelector = postConfirmMessageSelector()
  const deadline = Date.now() + Number(process.env.SKEDDA_POST_CONFIRM_WAIT_MS || 20_000)
  let lastText = ''
  let stableCount = 0

  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000)
    const messageText = await page.locator(messageSelector).evaluateAll((nodes) => {
      return nodes
        .map((node) => node.innerText || node.textContent || '')
        .map((text) => text.trim())
        .filter(Boolean)
        .join('\n')
    }).catch(() => '')
    const bodyText = await visibleText(page).catch(() => '')
    const changed = normalizeText(bodyText) !== normalizeText(beforeText)
    const hasMeaningfulMessage = /couldn|conflict|not available|confirmed|success|booking|error/i.test(messageText)

    if (messageText || changed) {
      const current = messageText || bodyText
      stableCount = current === lastText ? stableCount + 1 : 0
      lastText = current
      if (hasMeaningfulMessage || stableCount >= 1) {
        await page.waitForTimeout(800)
        return
      }
    }
  }
}

function extractSpaceName(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const index = lines.findIndex((line) => line === 'Filters')
  const candidates = lines.slice(index + 1).filter((line) => /^[A-Z]+\d+$/i.test(line))
  return candidates[0] || null
}

function classifyOutcome(text) {
  const lower = text.toLowerCase()
  if (
    lower.includes('too easy')
    || lower.includes('your booking is in')
    || lower.includes('confirmation email will hit your inbox')
    || lower.includes('booking confirmed')
  ) {
    return { success: true, status: 'confirmed', subject: 'confirmed', message: 'Skedda showed the success confirmation popup.' }
  }
  if (lower.includes('not available') || lower.includes('conflict') || lower.includes('already booked')) {
    return { success: false, status: 'confirmed-clicked-conflict', subject: 'confirm clicked, conflict shown', message: 'Confirm was clicked and Skedda showed a conflict/unavailable message.' }
  }
  return { success: false, status: 'confirm-clicked', subject: 'confirm clicked', message: 'Confirm was clicked; review screenshot/body text for the final Skedda state.' }
}

async function visibleText(page) {
  return page.locator('body').innerText({ timeout: 10_000 })
}

async function saveScreenshot(page, label) {
  const file = path.join(logDir, `${runStamp}-${label}.png`)
  await page.screenshot({ path: file, fullPage: false })
  return file
}

async function savePostConfirmScreenshot(page, label) {
  const file = path.join(logDir, `${runStamp}-${label}.png`)
  const toastClip = await findToastClip(page).catch(() => null)
  if (toastClip) {
    await page.screenshot({ path: file, clip: toastClip })
    return file
  }

  const messages = page.locator(postConfirmMessageSelector())
  const count = await messages.count().catch(() => 0)
  for (let index = 0; index < Math.min(count, 12); index += 1) {
    const message = messages.nth(index)
    const visible = await message.isVisible().catch(() => false)
    const box = visible ? await message.boundingBox().catch(() => null) : null
    if (box && box.width > 30 && box.height > 15) {
      await message.screenshot({ path: file })
      return file
    }
  }
  await page.screenshot({ path: file, fullPage: false })
  return file
}

async function findToastClip(page) {
  const viewport = page.viewportSize() || { width: 1440, height: 950 }
  const box = await page.evaluate(() => {
    function parseRgb(value) {
      const match = String(value).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?/)
      if (!match) return null
      return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
        a: match[4] === undefined ? 1 : Number(match[4]),
      }
    }
    function isToastLikeColor(value) {
      const rgb = parseRgb(value)
      if (!rgb || rgb.a === 0) return false
      const pinkError = rgb.r > 220 && rgb.g > 160 && rgb.g < 225 && rgb.b > 170 && rgb.b < 230
      const greenSuccess = rgb.g > 180 && rgb.r < 210 && rgb.b > 160 && rgb.b < 230
      return pinkError || greenSuccess
    }

    return Array.from(document.querySelectorAll('body *'))
      .map((el) => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        const text = (el.innerText || el.textContent || '').trim()
        return {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          text,
          backgroundColor: style.backgroundColor,
          colorMatch: isToastLikeColor(style.backgroundColor),
        }
      })
      .filter((item) => item.width > 250 && item.height > 24 && item.height < 120 && item.y >= 0 && item.y < 140)
      .filter((item) => item.colorMatch || /too easy|booking is in|sorry|didn'?t go through|couldn/i.test(item.text))
      .sort((a, b) => {
        const aTextScore = /too easy|booking is in|sorry|didn'?t go through|couldn/i.test(a.text) ? 0 : 1
        const bTextScore = /too easy|booking is in|sorry|didn'?t go through|couldn/i.test(b.text) ? 0 : 1
        return aTextScore - bTextScore || b.width - a.width
      })[0] || null
  })
  if (!box) return null

  const padding = 8
  const x = Math.max(0, Math.floor(box.x - padding))
  const y = Math.max(0, Math.floor(box.y - padding))
  const width = Math.min(viewport.width - x, Math.ceil(box.width + padding * 2))
  const height = Math.min(viewport.height - y, Math.ceil(box.height + padding * 2))
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

function postConfirmMessageSelector() {
  return [
    '[role="alert"]',
    '[role="status"]',
    '[aria-live]',
    '.toast',
    '.toastr',
    '.notification',
    '.alert',
    '.modal',
    '.ember-cli-notifications-notification',
  ].join(', ')
}

async function finish({ status, subject, lines, attachments = [] }) {
  const body = [
    `Status: ${status}`,
    `Run: ${new Date().toISOString()}`,
    ...lines,
  ].join('\n')
  await log(body)
  await sendMail(subject, body, attachments)
}

async function sendMail(subject, body, attachmentPaths = []) {
  const configs = []
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    configs.push({
      label: 'Gmail',
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
      from: process.env.MAIL_FROM || process.env.GMAIL_USER,
      to: process.env.MAIL_TO || process.env.GMAIL_USER,
    })
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    configs.push({
      label: 'SMTP',
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: process.env.MAIL_TO || process.env.SMTP_USER,
    })
  }

  if (!configs.length) {
    await log('SMTP not configured; skipped email notification.')
    return
  }

  for (const config of configs) {
    try {
      const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.pass },
      })
      await transporter.sendMail({
        from: config.from,
        to: config.to,
        subject,
        text: body,
        attachments: attachmentPaths.map((filePath) => ({
          filename: path.basename(filePath),
          path: filePath,
        })),
      })
      await log(`Email sent with ${config.label}.`)
      return
    } catch (error) {
      await log(`${config.label} email failed: ${error?.message || error}`)
    }
  }

  await log('All configured email methods failed; continuing without email notification.')
}

async function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  process.stdout.write(line)
  await fs.appendFile(logPath, line)
}

function clipText(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...` : text
}

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function stampForFilename(date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
