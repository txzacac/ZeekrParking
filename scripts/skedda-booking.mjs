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
const targetStart = process.env.SKEDDA_START_TIME || '07:30'
const targetEnd = process.env.SKEDDA_END_TIME || '18:00'
const carMake = process.env.SKEDDA_CAR_MAKE || 'your car make'
const carModel = process.env.SKEDDA_CAR_MODEL || 'your car model'
const licensePlate = process.env.SKEDDA_LICENSE_PLATE || 'YOUR-PLATE'
const args = new Set(process.argv.slice(2))
const madMode = args.has('--mad') || args.has('--aggressive') || args.has('--crazy')
  || ['1', 'true', 'yes'].includes((process.env.SKEDDA_MAD_MODE || '').toLowerCase())
const preferredSpaces = (process.env.SKEDDA_PREFERRED_SPACES || '12,13,14,15,16,17,18,19,20,21,22,23,24,25')
  .split(',')
  .map((space) => space.trim().toUpperCase())
  .filter(Boolean)
const preferredSpacePrefixes = (process.env.SKEDDA_PREFERRED_SPACE_PREFIXES || '')
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
const spaceClickSettleMs = Number(process.env.SKEDDA_SPACE_CLICK_SETTLE_MS || 450)
const noBookSettleMs = Number(process.env.SKEDDA_NO_BOOK_SETTLE_MS || 700)
const aggressiveSpaces = (process.env.SKEDDA_AGGRESSIVE_SPACES || '')
  .split(',')
  .map((space) => space.trim().toUpperCase())
  .filter(Boolean)
const madParallelSpaces = (process.env.SKEDDA_MAD_PARALLEL_SPACES || (aggressiveSpaces.length ? aggressiveSpaces.join(',') : preferredSpaces.join(',')))
  .split(',')
  .map((space) => space.trim().toUpperCase())
  .filter(Boolean)
const madParallelLimit = Number(process.env.SKEDDA_MAD_PARALLEL_LIMIT || 3)
const madParallelBookWaitMs = Number(process.env.SKEDDA_MAD_PARALLEL_BOOK_WAIT_MS || 90_000)
const bookingClickTime = process.env.SKEDDA_CLICK_TIME || targetStart
const aggressiveWindowMs = Number(process.env.SKEDDA_AGGRESSIVE_WINDOW_MS || (madMode ? 90_000 : 12_000))
const aggressiveClickSettleMs = Number(process.env.SKEDDA_AGGRESSIVE_CLICK_SETTLE_MS || 180)
const aggressiveNoBookSettleMs = Number(process.env.SKEDDA_AGGRESSIVE_NO_BOOK_SETTLE_MS || 120)
const aggressiveCloseWaitMs = Number(process.env.SKEDDA_AGGRESSIVE_CLOSE_WAIT_MS || 20)
const aggressiveParallel = madMode
  && ['1', 'true', 'yes'].includes((process.env.SKEDDA_AGGRESSIVE_PARALLEL || 'true').toLowerCase())

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

const successMarkerPath = path.join(logDir, `success-${target.date}.json`)
if (!dryRun && await fileExists(successMarkerPath)) {
  await log(`Success marker exists for ${target.date}; skipping this retry run.`)
  process.exit(0)
}

await log(`This run will try ${target.date} ${targetStart}-${targetEnd}. Click time: ${bookingClickTime}.`)

let context = null
let page = null
let connectedToExistingBrowser = false
let screenshotPath = null
let shouldKeepBrowserOpen = false

try {
  const browserSession = await withTimeout(
    openBrowserSession(),
    Number(process.env.SKEDDA_OPEN_BROWSER_TIMEOUT_MS || 60_000),
    'Opening or connecting to the Skedda Chrome browser timed out'
  )
  context = browserSession.context
  page = browserSession.page
  connectedToExistingBrowser = browserSession.connectedToExistingBrowser

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
    const result = await attemptPriorityBookings(context, page, bookingUrl)
    screenshotPath = result.screenshotPath
    await finish({
      status: result.status,
      subject: result.subject,
      attachments: screenshotPath ? [screenshotPath] : [],
      lines: result.lines,
    })
    if (result.status === 'confirmed') {
      await writeSuccessMarker(result)
    }
    shouldKeepBrowserOpen = result.confirmClicked
  } else {
    await log('Booking flow skipped.')
  }
} catch (error) {
  screenshotPath = screenshotPath || (page ? await saveScreenshot(page, 'error').catch(() => null) : null)
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
    await context?.close().catch(() => {})
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
  child.once('error', (error) => {
    log(`Detached Chrome spawn error: ${error?.message || error}`).catch(() => {})
  })
  child.once('exit', (code, signal) => {
    log(`Detached Chrome exited before/while CDP connection was opening. code=${code} signal=${signal}`).catch(() => {})
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
    const ok = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1_500) })
      .then((response) => response.ok)
      .catch(() => false)
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Chrome did not expose CDP at ${endpoint}.`)
}

function withTimeout(promise, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${message} after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
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

async function attemptPriorityBookings(context, page, bookingUrl) {
  const candidates = await findBookableSpaceCandidates(page, bookingUrl)
  if (!candidates.length) {
    throw new Error(`No bookable spaces found for priority list: ${preferredSpaces.join(', ')}`)
  }

  const attempts = []
  let lastScreenshotPath = null
  let lastText = ''
  let confirmClickedAny = false
  const madParallelSet = new Set(madParallelSpaces)
  const madParallelCandidates = madMode
    ? candidates.filter((candidate) => madParallelSet.has(candidate.name)).slice(0, madParallelLimit)
    : []
  const madParallelCandidateNames = new Set(madParallelCandidates.map((candidate) => candidate.name))
  const fallbackCandidates = madMode
    ? candidates.filter((candidate) => !madParallelCandidateNames.has(candidate.name))
    : candidates
  const madParallelRunners = madMode && aggressiveParallel
    ? await prepareParallelBookingRunners(context, bookingUrl, madParallelCandidates)
    : []

  await waitUntilBookingClickTime(bookingClickTime)

  async function tryCandidate(activePage, candidate, mode, options = {}) {
    const clickSettleMs = options.clickSettleMs ?? spaceClickSettleMs
    const bookSettleMs = options.bookSettleMs ?? noBookSettleMs
    const closeWaitMs = options.closeWaitMs ?? 100
    const allowAnyBook = options.allowAnyBook ?? true
    const prepareOnly = options.prepareOnly ?? false
    const waitForExactBookMs = options.waitForExactBookMs ?? 0

    await log(`Trying ${candidate.name} (${mode}) by clicking green dot at ${Math.round(candidate.x)},${Math.round(candidate.y)}.`)
    await clickSpaceCandidate(activePage, candidate)
    await activePage.waitForTimeout(clickSettleMs)
    const bookingOpened = await clickBookForStart(activePage, targetStart, { settleMs: bookSettleMs, allowAnyBook, waitForExactBookMs })
    if (!bookingOpened) {
      const reason = mode.startsWith('aggressive')
        ? `no Book for ${targetStart} during ${mode}`
        : await describeCurrentBookingBlock(activePage, targetStart)
      attempts.push(`${candidate.name} [${mode}]: ${reason}`)
      await log(`${candidate.name} skipped (${mode}): ${reason}; trying next priority space.`)
      await closeOpenPopover(activePage, closeWaitMs)
      return null
    }

    await activePage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await activePage.waitForTimeout(1_000)
    try {
      await setEndTime(activePage, targetEnd)
      await fillVehicleDetails(activePage)
    } catch (error) {
      const reason = `booking form could not be completed (${error?.message || error})`
      attempts.push(`${candidate.name} [${mode}]: ${reason}`)
      await log(`${candidate.name} skipped (${mode}): ${reason}; trying next priority space.`)
      await cancelDraftBooking(activePage)
      return null
    }

    const beforeConfirmText = await visibleText(activePage)
    if (!beforeConfirmText.includes('Confirm booking')) {
      const reason = `could not reach Confirm booking (${summarizeBookingText(beforeConfirmText, targetStart)})`
      attempts.push(`${candidate.name} [${mode}]: ${reason}`)
      await log(`${candidate.name} skipped (${mode}): ${reason}; trying next priority space.`)
      await cancelDraftBooking(activePage)
      return null
    }

    if (prepareOnly) {
      attempts.push(`${candidate.name} [${mode}]: draft ready`)
      await log(`${candidate.name} prepared booking draft (${mode}); waiting for serial confirmation.`)
      return {
        status: 'draft-ready',
        page: activePage,
        candidate,
        mode,
      }
    }

    if (dryRun) {
      lastScreenshotPath = await saveScreenshot(activePage, 'dry-run-ready')
      return {
        status: 'dry-run',
        subject: 'Skedda dry run ready',
        screenshotPath: lastScreenshotPath,
        confirmClicked: false,
        lines: [
          `Dry run reached Confirm booking for ${target.date} ${targetStart}-${targetEnd}.`,
          `Space: ${candidate.name}`,
          `Mode: ${mode}`,
          `Priority order: ${preferredSpaces.join(', ')}`,
          `Mad mode: ${madMode ? 'on' : 'off'}`,
          `Mad parallel spaces: ${madParallelSpaces.join(', ')}`,
          `Mad parallel limit: ${madParallelLimit}`,
          `Mad parallel book wait: ${madParallelBookWaitMs}ms`,
          `Click time: ${bookingClickTime}`,
          `Screenshot: ${lastScreenshotPath}`,
        ],
      }
    }

    await clickUniqueButton(activePage, 'Confirm booking')
    confirmClickedAny = true
    await activePage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await waitForPostConfirmMessage(activePage, beforeConfirmText)

    lastText = await visibleText(activePage)
    lastScreenshotPath = await savePostConfirmScreenshot(activePage, `after-confirm-${candidate.name}`)
    const outcome = classifyOutcome(lastText)
    attempts.push(`${candidate.name} [${mode}]: ${outcome.message}`)
    await log(`${candidate.name} after Confirm booking (${mode}): ${outcome.message}`)

    if (outcome.success) {
      return {
        status: outcome.status,
        subject: `Skedda ${outcome.subject}`,
        screenshotPath: lastScreenshotPath,
        confirmClicked: true,
        bookedSpace: outcome.bookedSpace || candidate.name,
        lines: [
          `Clicked Confirm booking for ${target.date} ${targetStart}-${targetEnd}.`,
          `Successful space: ${outcome.bookedSpace || candidate.name}`,
          `Mode: ${mode}`,
          `Outcome: ${outcome.message}`,
          `Attempts: ${attempts.join(' | ')}`,
          `Screenshot: ${lastScreenshotPath}`,
          '',
          clipText(lastText, 1800),
        ],
      }
    }

    await log(`${candidate.name} did not succeed (${mode}); trying next priority space.`)
    await cancelDraftBooking(activePage)
    return null
  }

  if (madMode && madParallelCandidates.length) {
    await log(`Mad parallel mode started for ${madParallelCandidates.map((candidate) => candidate.name).join(', ')} (${madParallelRunners.length ? 'parallel tabs' : 'single tab fallback'}).`)
    if (madParallelRunners.length) {
      const drafts = (await Promise.all(madParallelRunners.map((runner) => tryCandidate(
        runner.page,
        runner.candidate,
        `mad parallel ${runner.candidate.name}`,
        {
          clickSettleMs: aggressiveClickSettleMs,
          bookSettleMs: aggressiveNoBookSettleMs,
          closeWaitMs: aggressiveCloseWaitMs,
          allowAnyBook: false,
          prepareOnly: true,
          waitForExactBookMs: madParallelBookWaitMs,
        },
      )))).filter(Boolean)

      for (const draft of drafts) {
        const result = await confirmPreparedDraft(draft)
        if (result) {
          await closeParallelRunners(madParallelRunners.filter((runner) => runner.page !== draft.page))
          return result
        }
      }
      await closeParallelRunners(madParallelRunners)
    } else {
      for (const candidate of madParallelCandidates) {
        const result = await tryCandidate(page, candidate, 'mad parallel single-tab')
        if (result) return result
      }
    }
    await log(`Mad parallel phase ended; falling back to ${fallbackCandidates.map((candidate) => candidate.name).join(', ')}.`)
  }

  for (const candidate of fallbackCandidates) {
    const result = await tryCandidate(page, candidate, 'fallback')
    if (result) return result
  }

  return {
    status: confirmClickedAny ? 'confirm-clicked-no-success' : 'no-bookable-priority-space',
    subject: confirmClickedAny ? 'Skedda confirm clicked, no success' : 'Skedda no bookable priority space',
    screenshotPath: lastScreenshotPath,
    confirmClicked: confirmClickedAny,
    lines: [
      confirmClickedAny
        ? `Clicked Confirm booking for ${target.date} ${targetStart}-${targetEnd}, but no priority space produced the success popup.`
        : `No priority space exposed a Book for ${targetStart} option for ${target.date} ${targetStart}-${targetEnd}.`,
      `Priority order: ${preferredSpaces.join(', ')}`,
      `Attempts: ${attempts.join(' | ')}`,
      lastScreenshotPath ? `Screenshot: ${lastScreenshotPath}` : '',
      '',
      clipText(lastText, 1800),
    ].filter(Boolean),
  }

  async function confirmPreparedDraft(draft) {
    const activePage = draft.page
    const candidate = draft.candidate
    const mode = draft.mode

    if (dryRun) {
      lastScreenshotPath = await saveScreenshot(activePage, 'dry-run-ready')
      return {
        status: 'dry-run',
        subject: 'Skedda dry run ready',
        screenshotPath: lastScreenshotPath,
        confirmClicked: false,
        lines: [
          `Dry run reached Confirm booking for ${target.date} ${targetStart}-${targetEnd}.`,
          `Space: ${candidate.name}`,
          `Mode: ${mode}`,
          `Priority order: ${preferredSpaces.join(', ')}`,
          `Mad mode: ${madMode ? 'on' : 'off'}`,
          `Mad parallel spaces: ${madParallelSpaces.join(', ')}`,
          `Mad parallel limit: ${madParallelLimit}`,
          `Mad parallel book wait: ${madParallelBookWaitMs}ms`,
          `Click time: ${bookingClickTime}`,
          `Screenshot: ${lastScreenshotPath}`,
        ],
      }
    }

    const beforeConfirmText = await visibleText(activePage)
    if (!beforeConfirmText.includes('Confirm booking')) {
      const reason = `prepared draft lost Confirm booking (${summarizeBookingText(beforeConfirmText, targetStart)})`
      attempts.push(`${candidate.name} [${mode}]: ${reason}`)
      await log(`${candidate.name} skipped (${mode}): ${reason}; trying next prepared draft.`)
      await cancelDraftBooking(activePage)
      return null
    }

    await clickUniqueButton(activePage, 'Confirm booking')
    confirmClickedAny = true
    await activePage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await waitForPostConfirmMessage(activePage, beforeConfirmText)

    lastText = await visibleText(activePage)
    lastScreenshotPath = await savePostConfirmScreenshot(activePage, `after-confirm-${candidate.name}`)
    const outcome = classifyOutcome(lastText)
    attempts.push(`${candidate.name} [${mode}]: ${outcome.message}`)
    await log(`${candidate.name} after Confirm booking (${mode}): ${outcome.message}`)

    if (outcome.success) {
      return {
        status: outcome.status,
        subject: `Skedda ${outcome.subject}`,
        screenshotPath: lastScreenshotPath,
        confirmClicked: true,
        bookedSpace: outcome.bookedSpace || candidate.name,
        lines: [
          `Clicked Confirm booking for ${target.date} ${targetStart}-${targetEnd}.`,
          `Successful space: ${outcome.bookedSpace || candidate.name}`,
          `Mode: ${mode}`,
          `Outcome: ${outcome.message}`,
          `Attempts: ${attempts.join(' | ')}`,
          `Screenshot: ${lastScreenshotPath}`,
          '',
          clipText(lastText, 1800),
        ],
      }
    }

    await log(`${candidate.name} did not succeed (${mode}); trying next prepared draft.`)
    await cancelDraftBooking(activePage)
    return null
  }
}

async function findBookableSpaceCandidates(page, bookingUrl) {
  await prepareBookingMap(page, bookingUrl)
  const mapped = await mapPreferredSpacesFromMapGeometry(page)
  for (const candidate of mapped) {
    await log(`Mapped priority space ${candidate.name} to candidate point at ${Math.round(candidate.x)},${Math.round(candidate.y)} (${candidate.source || 'unknown'}).`)
  }
  return mapped
}

async function prepareParallelBookingRunners(context, bookingUrl, candidates) {
  if (!candidates.length) return []

  await log(`Preparing ${candidates.length} parallel booking tabs: ${candidates.map((candidate) => candidate.name).join(', ')}.`)
  const runners = await Promise.all(candidates.map(async (candidate) => {
    const runnerPage = await context.newPage()
    runnerPage.setDefaultTimeout(Number(process.env.SKEDDA_TIMEOUT_MS || 20_000))
    try {
      await prepareBookingMap(runnerPage, bookingUrl)
      const mapped = await mapPreferredSpacesFromMapGeometry(runnerPage)
      const mappedCandidate = mapped.find((item) => item.name === candidate.name) || candidate
      await log(`Prepared parallel tab for ${candidate.name} at ${Math.round(mappedCandidate.x)},${Math.round(mappedCandidate.y)}.`)
      return { page: runnerPage, candidate: mappedCandidate }
    } catch (error) {
      await runnerPage.close().catch(() => {})
      await log(`Failed to prepare parallel tab for ${candidate.name}: ${error?.message || error}`)
      return null
    }
  }))

  return runners.filter(Boolean)
}

async function closeParallelRunners(runners) {
  await Promise.all(runners.map((runner) => runner.page.close().catch(() => {})))
}

async function mapPreferredSpacesFromMapGeometry(page) {
  return page.evaluate(({ spaces }) => {
    function parseRgb(value) {
      const match = String(value).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
      return match ? match.slice(1, 4).map(Number) : null
    }
    function isAvailableGreen(value) {
      const rgb = parseRgb(value)
      return Boolean(rgb && rgb[1] > 140 && rgb[0] < 80 && rgb[2] > 80 && rgb[2] < 190)
    }
    function isParkingFill(value) {
      const rgb = parseRgb(value)
      return Boolean(rgb && Math.max(...rgb) > 20)
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
    const topLabels = ['25', '24', '23', '22', '21', '20', '19', '18', '17', '16', '15', '14', '13', '12', '11', '10']
    const bottomLabels = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
    const parkingRects = nodes
      .filter((el) => el.tagName.toLowerCase() === 'rect')
      .map((el) => {
        const box = rectOf(el)
        return { ...box, fill: getComputedStyle(el).fill }
      })
      .filter((box) => box.width > 60 && box.width < 180 && box.height > 140 && box.height < 340 && isParkingFill(box.fill))

    const labelCandidates = nodes
      .map((el) => {
        const text = (el.textContent || '').trim()
        if (!/^\d{1,2}$/.test(text)) return null
        const number = Number(text)
        if (number < 1 || number > 25) return null
        const box = rectOf(el)
        return { name: text, ...box }
      })
      .filter(Boolean)
      .filter((label) => label.width > 0 && label.width < 80 && label.height > 0 && label.height < 50)

    const spacesByLabel = new Map()
    for (const label of labelCandidates) {
      const rect = parkingRects
        .filter((candidate) => label.x >= candidate.left - 8 && label.x <= candidate.right + 8
          && label.y >= candidate.top - 35 && label.y <= candidate.bottom + 35)
        .sort((a, b) => Math.abs(label.y - a.bottom) - Math.abs(label.y - b.bottom)
          || Math.abs(label.x - a.x) - Math.abs(label.x - b.x))[0]
      if (!rect) continue

      const score = Math.abs(label.y - rect.bottom) + Math.abs(label.x - rect.x)
      const current = spacesByLabel.get(label.name)
      if (!current || score < current.score) {
        spacesByLabel.set(label.name, { ...rect, name: label.name, source: 'label', score })
      }
    }

    const yBuckets = []
    for (const box of parkingRects.sort((a, b) => a.y - b.y || a.x - b.x)) {
      const bucket = yBuckets.find((row) => Math.abs(row.y - box.y) < 80)
      if (bucket) {
        bucket.boxes.push(box)
        bucket.y = bucket.boxes.reduce((sum, item) => sum + item.y, 0) / bucket.boxes.length
      } else {
        yBuckets.push({ y: box.y, boxes: [box] })
      }
    }

    const rows = yBuckets
      .filter((row) => row.boxes.length >= 3)
      .sort((a, b) => a.y - b.y)
      .slice(0, 2)

    const topRow = (rows[0]?.boxes || [])
      .sort((a, b) => a.x - b.x)
      .slice(0, topLabels.length)
      .map((box, index) => ({ ...box, name: topLabels[index] }))

    const bottomRow = (rows[1]?.boxes || [])
      .sort((a, b) => a.x - b.x)
      .slice(0, bottomLabels.length)
      .map((box, index) => ({ ...box, name: bottomLabels[index] }))

    const spacesByName = new Map([...topRow, ...bottomRow].map((space) => [space.name, { ...space, source: 'row-fallback' }]))
    for (const [name, space] of spacesByLabel) {
      spacesByName.set(name, space)
    }
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
      return dot ? { name, x: dot.x, y: dot.y, source: space.source } : { name, x: space.x, y: space.y, source: space.source }
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

async function waitUntilBookingClickTime(time) {
  const maxWaitMs = Number(process.env.SKEDDA_WAIT_BEFORE_START_MAX_MS || 120_000)
  const waitMs = millisecondsUntilTodayTime(time)
  if (waitMs <= 0 || waitMs > maxWaitMs) return

  await log(`Map is ready; waiting ${waitMs}ms until ${time} before clicking priority spaces.`)
  await new Promise((resolve) => setTimeout(resolve, waitMs))
}

function millisecondsUntilTodayTime(time) {
  const [targetHour, targetMinute] = time.split(':').map(Number)
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date())
  const lookup = Object.fromEntries(nowParts.map((part) => [part.type, part.value]))
  const currentSeconds = Number(lookup.hour) * 3600 + Number(lookup.minute) * 60 + Number(lookup.second)
  const targetSeconds = targetHour * 3600 + targetMinute * 60
  return (targetSeconds - currentSeconds) * 1000
}

async function closeOpenPopover(page, waitMs = 100) {
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(waitMs)
}

async function cancelDraftBooking(page) {
  const cancel = page.getByRole('button', { name: 'Cancel booking', exact: true })
  if (await cancel.count()) {
    await cancel.first().click().catch(() => {})
    await page.waitForTimeout(800)
  }
}

async function describeCurrentBookingBlock(page, time) {
  const text = await visibleText(page).catch(() => '')
  return summarizeBookingText(text, time)
}

function summarizeBookingText(text, time) {
  const normalized = normalizeText(text)
  const lower = normalized.toLowerCase()
  const availableBookTimes = Array.from(new Set(
    Array.from(normalized.matchAll(/Book for\s+(\d{2}:\d{2})/g)).map((match) => match[1]),
  ))

  if (lower.includes('not available')) return `not available for ${time}`
  if (lower.includes('already booked')) return `already booked at ${time}`
  if (lower.includes('conflict')) return `conflict at ${time}`
  if (lower.includes('other available times')) {
    return availableBookTimes.length
      ? `no Book for ${time}; other available times: ${availableBookTimes.join(', ')}`
      : `no Book for ${time}; Skedda showed other available times`
  }
  if (availableBookTimes.length) {
    return `no Book for ${time}; available book buttons: ${availableBookTimes.join(', ')}`
  }
  if (lower.includes('new booking')) return `booking draft opened but start time ${time} was not available`
  return `no Book for ${time} option found`
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

async function clickBookForStart(page, time, options = {}) {
  const settleMs = options.settleMs ?? noBookSettleMs
  const allowAnyBook = options.allowAnyBook ?? true
  const waitForExactBookMs = options.waitForExactBookMs ?? 0
  const text = await visibleText(page)
  if (text.includes('New booking') && (text.includes(`From ${time}`) || page.url().includes(`nbstart=`))) {
    return true
  }

  const preferred = page.getByRole('button', { name: `Book for ${time}`, exact: true })
  if (await preferred.count()) {
    await preferred.first().click()
    return true
  }

  const startOption = page.getByRole('button', { name: time, exact: true })
  if (await startOption.count()) {
    await startOption.last().click()
    await page.waitForTimeout(800)
  }

  if (allowAnyBook) {
    const anyBook = page.getByRole('button', { name: /^Book for / })
    if (await anyBook.count()) {
      await anyBook.first().click()
      return true
    }
  }

  if (waitForExactBookMs > 0) {
    const deadline = Date.now() + waitForExactBookMs
    await log(`Waiting up to ${waitForExactBookMs}ms for Book for ${time} to appear without re-clicking the space.`)
    while (Date.now() < deadline) {
      const exact = page.getByRole('button', { name: `Book for ${time}`, exact: true })
      if (await exact.count()) {
        await exact.first().click()
        return true
      }
      const currentText = await visibleText(page).catch(() => '')
      if (currentText.includes('New booking') && (currentText.includes(`From ${time}`) || page.url().includes(`nbstart=`))) {
        return true
      }
      await page.waitForTimeout(200)
    }
  }

  await page.waitForTimeout(settleMs)
  const settledText = await visibleText(page)
  if (settledText.includes('New booking') && (settledText.includes(`From ${time}`) || page.url().includes('nbstart='))) {
    return true
  }

  return false
}

async function setEndTime(page, time) {
  const text = await visibleText(page)
  const normalized = normalizeText(text)
  if (normalized.includes(`to ${time}`) || normalized.includes(`${targetStart}-${time}`)) return

  const endButton = page.getByRole('button', { name: /^to / })
  if (await endButton.count()) {
    await endButton.first().click()
  } else {
    const endCombobox = page.getByRole('combobox', { name: /^to / })
    if (await endCombobox.count()) {
      await endCombobox.first().click()
    } else {
      const clicked = await clickTextByPattern(page, /^to \d{1,2}:\d{2}$/i)
      if (!clicked) throw new Error('Could not find end-time control.')
    }
  }
  await page.waitForTimeout(500)

  const option = page.getByRole('button', { name: time, exact: true })
  const count = await option.count()
  if (count) {
    await option.nth(count - 1).click()
  } else {
    const optionByText = await clickTextByPattern(page, new RegExp(`^${escapeRegExp(time)}$`))
    if (!optionByText) throw new Error(`Could not find end-time option ${time}.`)
  }
  await page.waitForTimeout(1_000)
}

async function clickTextByPattern(page, pattern) {
  const target = await page.evaluate((source) => {
    const regex = new RegExp(source, 'i')
    const matches = Array.from(document.querySelectorAll('body *'))
      .map((el) => {
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return {
          text,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          area: rect.width * rect.height,
          visible: rect.width > 0 && rect.height > 0
            && rect.bottom > 0 && rect.right > 0
            && rect.top < window.innerHeight && rect.left < window.innerWidth
            && style.visibility !== 'hidden'
            && style.display !== 'none',
        }
      })
      .filter((item) => item.visible && regex.test(item.text))
      .sort((a, b) => a.area - b.area)
    return matches[0] || null
  }, pattern.source)
  if (!target) return false
  await page.mouse.click(target.x, target.y)
  return true
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
  const existingBooking = findExistingTargetBooking(text)
  if (
    lower.includes('too easy')
    || lower.includes('your booking is in')
    || lower.includes('confirmation email will hit your inbox')
    || lower.includes('booking confirmed')
  ) {
    return { success: true, status: 'confirmed', subject: 'confirmed', message: 'Skedda showed the success confirmation popup.', bookedSpace: existingBooking?.space || null }
  }
  if (lower.includes('quota is exceeded') && existingBooking) {
    return {
      success: true,
      status: 'confirmed-existing-booking',
      subject: 'confirmed existing booking',
      message: `Skedda says the quota is exceeded because a booking already exists for ${target.date} ${targetStart}-${targetEnd}${existingBooking.space ? ` in space ${existingBooking.space}` : ''}.`,
      bookedSpace: existingBooking.space || null,
    }
  }
  if (lower.includes('not available') || lower.includes('conflict') || lower.includes('already booked')) {
    return { success: false, status: 'confirmed-clicked-conflict', subject: 'confirm clicked, conflict shown', message: 'Confirm was clicked and Skedda showed a conflict/unavailable message.' }
  }
  return { success: false, status: 'confirm-clicked', subject: 'confirm clicked', message: 'Confirm was clicked; review screenshot/body text for the final Skedda state.' }
}

function findExistingTargetBooking(text) {
  const lines = text.split('\n').map((line) => normalizeText(line)).filter(Boolean)
  const targetDate = new Date(`${target.date}T00:00:00`)
  const day = targetDate.getDate()
  const shortMonth = targetDate.toLocaleString('en-GB', { month: 'short', timeZone: timezone }).toLowerCase()
  const dayMonth = `${day} ${shortMonth}`
  const slashDate = `${String(day).padStart(2, '0')}/${String(targetDate.getMonth() + 1).padStart(2, '0')}/${targetDate.getFullYear()}`
  const lowerText = normalizeText(text).toLowerCase()
  const quotaMatchesTarget = lowerText.includes('quota is exceeded') && lowerText.includes(slashDate)

  for (const line of lines) {
    const lowerLine = line.toLowerCase()
    const isTargetDate = lowerLine.includes(dayMonth) || lowerLine.includes(slashDate)
    if (!isTargetDate || !line.includes(targetStart) || !line.includes('|')) continue
    return { line, space: parseSpaceFromBookingLine(line) }
  }

  if (quotaMatchesTarget) {
    const bookingLine = lines.find((line) => line.includes(targetStart) && line.includes('|'))
    if (bookingLine) return { line: bookingLine, space: parseSpaceFromBookingLine(bookingLine) }
    return { line: null, space: null }
  }

  return null
}

function parseSpaceFromBookingLine(line) {
  const match = line.match(/\|\s*([A-Z]?\d+)\s*$/i)
  return match ? match[1].toUpperCase() : null
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
  const logContent = await fs.readFile(logPath, 'utf8').catch((error) => `Could not read run log: ${error?.message || error}`)
  const mailBody = [
    body,
    '',
    '--- Run log ---',
    `Log file: ${logPath}`,
    '',
    logContent.trim(),
  ].join('\n')
  await sendMail(subject, mailBody, attachments)
}

async function writeSuccessMarker(result) {
  const payload = {
    targetDate: target.date,
    time: `${targetStart}-${targetEnd}`,
    status: result.status,
    subject: result.subject,
    screenshotPath: result.screenshotPath || null,
    bookedSpace: result.bookedSpace || null,
    run: new Date().toISOString(),
  }
  await fs.writeFile(successMarkerPath, JSON.stringify(payload, null, 2), 'utf8')
  await log(`Wrote success marker: ${successMarkerPath}`)
}

async function fileExists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false)
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

