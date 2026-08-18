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
const timezone = process.env.SKEDDA_TIMEZONE || 'Europe/Amsterdam'
const browserDebugPort = Number(process.env.SKEDDA_BROWSER_DEBUG_PORT || 9223)
const headless = (process.env.SKEDDA_HEADLESS || 'false').toLowerCase() !== 'false'
const checkinName = process.env.SKEDDA_CHECKIN_NAME || 'Your Name'
const targetDate = process.env.SKEDDA_CHECKIN_DATE || todayInTimezone(new Date())
const forceCheckin = ['1', 'true', 'yes'].includes((process.env.SKEDDA_CHECKIN_FORCE || '').toLowerCase())
const skipDates = (process.env.SKEDDA_CHECKIN_SKIP_DATES || '')
  .split(',')
  .map((date) => date.trim())
  .filter(Boolean)

await fs.mkdir(logDir, { recursive: true })
const runStamp = stampForFilename(new Date())
const logPath = path.join(logDir, `${runStamp}-checkin.log`)

if (!forceCheckin && skipDates.includes(targetDate)) {
  await log(`Skipping check-in for ${targetDate}; date is listed in SKEDDA_CHECKIN_SKIP_DATES.`)
  process.exit(0)
}

const browserSession = await openBrowserSession()
const { page, connectedToExistingBrowser } = browserSession
let screenshotPath = null

try {
  page.setDefaultTimeout(Number(process.env.SKEDDA_TIMEOUT_MS || 20_000))
  const checkinUrl = buildCheckinUrl(targetDate)
  await log(`Opening ${checkinUrl}`)
  await page.goto(checkinUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})

  if (await isLoginPage(page)) {
    screenshotPath = await saveScreenshot(page, 'checkin-login-required')
    await finish({
      status: 'login-required',
      subject: 'Skedda check-in login required',
      attachments: [screenshotPath],
      lines: [
        `Skedda redirected to login before check-in for ${targetDate}.`,
        'Run: npm run skedda:login',
        `Screenshot: ${screenshotPath}`,
      ],
    })
    process.exitCode = 2
  }

  if (!process.exitCode) {
    await dismissUsagePrompt(page)
    const result = await performCheckIn(page)
    screenshotPath = result.screenshotPath
    await finish({
      status: result.status,
      subject: result.subject,
      attachments: screenshotPath ? [screenshotPath] : [],
      lines: result.lines,
    })
    process.exitCode = result.exitCode || 0
  }
} catch (error) {
  screenshotPath = screenshotPath || await saveScreenshot(page, 'checkin-error').catch(() => null)
  await finish({
    status: 'error',
    subject: 'Skedda check-in error',
    attachments: screenshotPath ? [screenshotPath] : [],
    lines: [
      `Error while checking in for ${targetDate}:`,
      error?.stack || String(error),
      screenshotPath ? `Screenshot: ${screenshotPath}` : '',
    ].filter(Boolean),
  })
  process.exitCode = 1
} finally {
  if (connectedToExistingBrowser) {
    await log('Connected to an existing Skedda browser; leaving that browser open and exiting this runner.')
    process.exit(process.exitCode || 0)
  }
}

function buildCheckinUrl(date) {
  const params = new URLSearchParams({
    viewend: date,
    viewtype: '2',
  })
  return `https://zeekr.skedda.com/booking?${params.toString()}`
}

async function performCheckIn(page) {
  const bookingInfo = await findMyBookingInfo(page)
  await log(`Today booking info: ${formatBookingInfo(bookingInfo)}`)
  await clickMyBooking(page)

  let currentText = await visibleText(page)
  if (isCheckedInText(currentText)) {
    return await checkinSuccess(page, 'Already checked in.', bookingInfo)
  }

  const manage = page.getByRole('button', { name: /Manage/i })
  if (!(await manage.count())) {
    const screenshot = await saveScreenshot(page, 'checkin-no-manage')
    return {
      status: 'no-manage',
      subject: subjectWithSpace('Skedda check-in: Manage not found', bookingInfo),
      screenshotPath: screenshot,
      exitCode: 1,
      lines: [
        `Found/clicked booking name "${checkinName}" for ${targetDate}, but Manage button was not found.`,
        formatBookingInfo(bookingInfo),
        `Screenshot: ${screenshot}`,
      ],
    }
  }

  await manage.first().click()
  await page.waitForTimeout(500)

  const checkinItem = page.getByText(/Check in/i).first()
  if (!(await checkinItem.count())) {
    const screenshot = await saveScreenshot(page, 'checkin-menu-no-item')
    return {
      status: 'check-in-not-found',
      subject: subjectWithSpace('Skedda check-in unavailable', bookingInfo),
      screenshotPath: screenshot,
      exitCode: 1,
      lines: [
        `Manage menu opened for "${checkinName}", but Check in was not found.`,
        formatBookingInfo(bookingInfo),
        `Screenshot: ${screenshot}`,
      ],
    }
  }

  await clickVisibleText(page, 'Check in', 'Check in menu item')
  await page.waitForTimeout(1_000)

  const afterMenuText = await visibleText(page)
  if (/check in disabled|check in closed/i.test(afterMenuText)) {
    const screenshot = await saveScreenshot(page, 'checkin-unavailable')
    return {
      status: 'check-in-unavailable',
      subject: subjectWithSpace('Skedda check-in unavailable', bookingInfo),
      screenshotPath: screenshot,
      exitCode: 1,
      lines: [
        `Check-in is not available for "${checkinName}" on ${targetDate}.`,
        formatBookingInfo(bookingInfo),
        `Screenshot: ${screenshot}`,
        '',
        clipText(afterMenuText, 1800),
      ],
    }
  }

  if (/Yes, do it/i.test(afterMenuText)) {
    await clickVisibleText(page, 'Yes, do it', 'check-in confirmation')
    await page.waitForTimeout(1_000)
    currentText = await visibleText(page)
    if (isCheckedInText(currentText)) {
      return await checkinSuccess(page, 'Clicked Yes, do it and Skedda showed checked-in status.', bookingInfo)
    }
  }

  await checkAllVisibleBoxes(page)

  const checkinButtons = page.getByRole('button', { name: /Check in/i })
  const buttonCount = await checkinButtons.count()
  if (!buttonCount) {
    const screenshot = await saveScreenshot(page, 'checkin-modal-no-button')
    return {
      status: 'check-in-button-not-found',
      subject: subjectWithSpace('Skedda check-in button not found', bookingInfo),
      screenshotPath: screenshot,
      exitCode: 1,
      lines: [
        'Check-in dialog opened, but final Check in button was not found.',
        formatBookingInfo(bookingInfo),
        `Screenshot: ${screenshot}`,
      ],
    }
  }

  await checkinButtons.nth(buttonCount - 1).click()
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await waitForCheckinResult(page)
  const screenshot = await saveScreenshot(page, 'checkin-after-submit')
  const text = await visibleText(page)
  const success = /checked in|check.?in complete|success|too easy/i.test(text)
    && !/not checked in|check in disabled|check in closed|couldn|sorry|error|failed/i.test(text)

  return {
    status: success ? 'checked-in' : 'check-in-submitted',
    subject: subjectWithSpace(success ? 'Skedda checked in' : 'Skedda check-in submitted', bookingInfo),
    screenshotPath: screenshot,
    exitCode: success ? 0 : 1,
    lines: [
      `Clicked Check in for "${checkinName}" on ${targetDate}.`,
      formatBookingInfo(bookingInfo),
      `Screenshot: ${screenshot}`,
      '',
      clipText(text, 1800),
    ],
  }
}

async function checkinSuccess(page, message, bookingInfo) {
  const screenshot = await saveScreenshot(page, 'checkin-success')
  const text = await visibleText(page)
  return {
    status: 'checked-in',
    subject: subjectWithSpace('Skedda checked in', bookingInfo),
    screenshotPath: screenshot,
    exitCode: 0,
    lines: [
      `${message} "${checkinName}" on ${targetDate}.`,
      formatBookingInfo(bookingInfo),
      `Screenshot: ${screenshot}`,
      '',
      clipText(text, 1800),
    ],
  }
}

function isCheckedInText(text) {
  return /checked in/i.test(text) && !/not checked in/i.test(text)
}

async function clickMyBooking(page) {
  await clickVisibleText(page, checkinName, `booking name "${checkinName}"`)
  await page.waitForTimeout(800)
}

async function findMyBookingInfo(page) {
  return await page.evaluate((name) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim()
    const isVisible = (el, rect) => {
      const style = getComputedStyle(el)
      return rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0
        && rect.top < window.innerHeight && rect.left < window.innerWidth
        && style.visibility !== 'hidden'
        && style.display !== 'none'
    }
    const items = Array.from(document.querySelectorAll('body *'))
      .map((el) => {
        const text = normalize(el.innerText || el.textContent)
        const rect = el.getBoundingClientRect()
        return {
          text,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
          area: rect.width * rect.height,
          visible: text && isVisible(el, rect),
        }
      })
      .filter((item) => item.visible && item.text.length <= 120)

    const nameMatch = items
      .filter((item) => item.text.includes(name))
      .sort((a, b) => a.area - b.area)[0]
    if (!nameMatch) return { space: 'unknown', time: 'unknown', matchedName: name }

    const sameRow = items
      .filter((item) => Math.abs(item.y - nameMatch.y) <= 14 && item.right <= nameMatch.left + 30)
      .sort((a, b) => a.x - b.x)

    const timeMatch = sameRow.find((item) => /^\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}/.test(item.text))
    const spaceMatch = sameRow
      .filter((item) => /^(?:Z)?\d{1,3}$/i.test(item.text))
      .sort((a, b) => b.x - a.x)[0]

    return {
      space: spaceMatch ? spaceMatch.text.toUpperCase().replace(/^Z/, '') : 'unknown',
      time: timeMatch ? timeMatch.text : 'unknown',
      matchedName: nameMatch.text,
    }
  }, checkinName).catch((error) => ({
    space: 'unknown',
    time: 'unknown',
    matchedName: checkinName,
    error: error?.message || String(error),
  }))
}

function formatBookingInfo(info) {
  const parts = [
    `Today parking: Space ${info?.space || 'unknown'}`,
    `Parking space: ${info?.space || 'unknown'}`,
    `Booking time: ${info?.time || 'unknown'}`,
  ]
  if (info?.error) parts.push(`Booking info error: ${info.error}`)
  return parts.join('\n')
}

function subjectWithSpace(subject, info) {
  const space = info?.space && info.space !== 'unknown' ? ` - Space ${info.space}` : ''
  return `${subject}${space}`
}

async function clickVisibleText(page, textToFind, label) {
  const target = await page.evaluate((name) => {
    const matches = Array.from(document.querySelectorAll('body *'))
      .map((el) => {
        const text = (el.innerText || el.textContent || '').trim()
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return {
          text,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
          area: rect.width * rect.height,
          visible: rect.width > 0 && rect.height > 0
            && rect.bottom > 0 && rect.right > 0
            && rect.top < window.innerHeight && rect.left < window.innerWidth
            && style.visibility !== 'hidden'
            && style.display !== 'none',
        }
      })
      .filter((item) => item.visible && item.text.includes(name))
      .sort((a, b) => a.area - b.area)
    return matches[0] || null
  }, textToFind)

  if (!target) {
    const screenshot = await saveScreenshot(page, 'checkin-visible-text-not-found')
    throw new Error(`Could not find visible ${label} on ${targetDate}. Screenshot: ${screenshot}`)
  }
  await page.mouse.click(target.x, target.y)
}

async function checkAllVisibleBoxes(page) {
  const boxes = page.locator('input[type="checkbox"]:visible')
  const count = await boxes.count()
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index)
    const checked = await box.isChecked().catch(() => false)
    if (!checked) await box.check({ force: true }).catch(() => {})
  }
}

async function waitForCheckinResult(page) {
  const deadline = Date.now() + Number(process.env.SKEDDA_CHECKIN_WAIT_MS || 12_000)
  while (Date.now() < deadline) {
    const text = await visibleText(page).catch(() => '')
    if (/checked in|success|sorry|couldn|failed|error/i.test(text)) return
    await page.waitForTimeout(800)
  }
}

async function openBrowserSession() {
  const endpoint = `http://127.0.0.1:${browserDebugPort}`
  const browser = await chromium.connectOverCDP(endpoint).catch(() => null)
  if (browser) {
    await log(`Connected to existing Skedda browser at ${endpoint}.`)
    const context = browser.contexts()[0] || await browser.newContext({ viewport: { width: 1440, height: 950 } })
    const page = await context.newPage()
    return { page, connectedToExistingBrowser: true }
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
  return { page, connectedToExistingBrowser: true }
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

async function isLoginPage(page) {
  const url = page.url()
  const title = await page.title().catch(() => '')
  const text = await visibleText(page).catch(() => '')
  return url.includes('/account/login') || title.includes('Log in') || text.includes('Log in with SSO')
}

async function dismissUsagePrompt(page) {
  const decline = page.getByRole('button', { name: 'Decline', exact: true })
  if (await decline.count()) {
    await decline.first().click().catch(() => {})
    await page.waitForTimeout(500)
  }
}

async function visibleText(page) {
  return page.locator('body').innerText({ timeout: 10_000 })
}

async function saveScreenshot(page, label) {
  const file = path.join(logDir, `${runStamp}-${label}.png`)
  await page.screenshot({ path: file, fullPage: false })
  return file
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

function todayInTimezone(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${lookup.year}-${lookup.month}-${lookup.day}`
}

function stampForFilename(date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function clipText(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...` : text
}
