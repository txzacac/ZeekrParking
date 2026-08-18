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
const bookingName = process.env.SKEDDA_CHECKIN_NAME || process.env.SKEDDA_MODIFY_NAME || 'Your Name'
const targetStart = process.env.SKEDDA_MODIFY_START_TIME || '09:00'
const targetEnd = process.env.SKEDDA_MODIFY_END_TIME || '18:00'
const dryRun = ['1', 'true', 'yes'].includes((process.env.SKEDDA_DRY_RUN || '').toLowerCase())

await fs.mkdir(logDir, { recursive: true })
const runStamp = stampForFilename(new Date())
const logPath = path.join(logDir, `${runStamp}-modify.log`)

const target = process.env.SKEDDA_MODIFY_DATE
  ? { date: process.env.SKEDDA_MODIFY_DATE, skipped: false, reason: 'SKEDDA_MODIFY_DATE override' }
  : nextBookingTarget(new Date())

if (target.skipped) {
  await finish({
    status: 'skipped',
    subject: 'Skedda modify skipped',
    lines: [
      `Skipped: ${target.reason}`,
      `Timezone: ${timezone}`,
      `Run time: ${new Date().toISOString()}`,
    ],
  })
  process.exit(0)
}

const browserSession = await openBrowserSession()
const { page, connectedToExistingBrowser } = browserSession
let screenshotPath = null

try {
  page.setDefaultTimeout(Number(process.env.SKEDDA_TIMEOUT_MS || 20_000))
  const listUrl = buildListUrl(target.date)
  await log(`Opening ${listUrl}`)
  await page.goto(listUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})

  if (await isLoginPage(page)) {
    screenshotPath = await saveScreenshot(page, 'modify-login-required')
    await finish({
      status: 'login-required',
      subject: 'Skedda modify login required',
      attachments: [screenshotPath],
      lines: [
        `Skedda redirected to login before modifying ${target.date}.`,
        'Run: npm run skedda:login',
        `Screenshot: ${screenshotPath}`,
      ],
    })
    process.exitCode = 2
  }

  if (!process.exitCode) {
    await dismissUsagePrompt(page)
    const result = await modifyBooking(page)
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
  screenshotPath = screenshotPath || await saveScreenshot(page, 'modify-error').catch(() => null)
  await finish({
    status: 'error',
    subject: 'Skedda modify error',
    attachments: screenshotPath ? [screenshotPath] : [],
    lines: [
      `Error while modifying ${target.date} to ${targetStart}-${targetEnd}:`,
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

function buildListUrl(date) {
  const params = new URLSearchParams({
    viewdate: date,
    viewend: date,
    viewtype: '2',
  })
  return `https://zeekr.skedda.com/booking?${params.toString()}`
}

async function modifyBooking(page) {
  await log(`Looking for "${bookingName}" on ${target.date}.`)
  await clickVisibleText(page, bookingName, `booking name "${bookingName}"`)
  await page.waitForTimeout(800)

  const selectedText = await visibleText(page)
  await log(`Selected booking summary: ${clipText(normalizeText(selectedText), 900)}`)

  if (selectedText.includes(`${targetStart}–${targetEnd}`) || selectedText.includes(`${targetStart}-${targetEnd}`)) {
    const screenshot = await saveScreenshot(page, 'modify-already-updated')
    return {
      status: 'already-updated',
      subject: 'Skedda booking already modified',
      screenshotPath: screenshot,
      exitCode: 0,
      lines: [
        `Booking for "${bookingName}" on ${target.date} already appears to be ${targetStart}-${targetEnd}.`,
        `Screenshot: ${screenshot}`,
      ],
    }
  }

  const manage = page.getByRole('button', { name: /Manage/i })
  if (!(await manage.count())) {
    const screenshot = await saveScreenshot(page, 'modify-no-manage')
    return {
      status: 'no-manage',
      subject: 'Skedda modify: Manage not found',
      screenshotPath: screenshot,
      exitCode: 1,
      lines: [
        `Found/clicked "${bookingName}" for ${target.date}, but Manage button was not found.`,
        `Screenshot: ${screenshot}`,
      ],
    }
  }

  await manage.first().click()
  await page.waitForTimeout(500)
  await clickVisibleText(page, 'Edit booking', 'Edit booking menu item')
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(1_000)

  await setEditTime(page, 'From', targetStart)
  await setEditTime(page, 'to', targetEnd)

  const readyScreenshot = await saveScreenshot(page, dryRun ? 'modify-dry-run-ready' : 'modify-ready')
  if (dryRun) {
    return {
      status: 'dry-run',
      subject: 'Skedda modify dry run ready',
      screenshotPath: readyScreenshot,
      exitCode: 0,
      lines: [
        `Dry run reached edit form for "${bookingName}" on ${target.date}.`,
        `Target time: ${targetStart}-${targetEnd}`,
        `Screenshot: ${readyScreenshot}`,
      ],
    }
  }

  await clickSaveChanges(page)
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await waitForModifyResult(page)

  const screenshot = await saveScreenshot(page, 'modify-after-save')
  const text = await visibleText(page)
  const success = isModifySuccess(text)
  await log(`After save status: ${success ? 'success' : 'unknown/failure'}.`)

  return {
    status: success ? 'modified' : 'modify-submitted',
    subject: success ? 'Skedda booking modified' : 'Skedda modify submitted',
    screenshotPath: screenshot,
    exitCode: success ? 0 : 1,
    lines: [
      `Tried to modify "${bookingName}" on ${target.date} to ${targetStart}-${targetEnd}.`,
      `Result: ${success ? 'Skedda shows the updated booking time.' : 'Review screenshot/body text; success was not confirmed by text.'}`,
      `Screenshot: ${screenshot}`,
      '',
      clipText(text, 1800),
    ],
  }
}

async function setEditTime(page, label, time) {
  const text = await visibleText(page)
  if (text.includes(`${label} ${time}`)) {
    await log(`${label} time already ${time}.`)
    return
  }

  const button = page.getByRole('button', { name: new RegExp(`^${escapeRegExp(label)} `, 'i') })
  await log(`Changing ${label} time to ${time}.`)
  if (await button.count()) {
    await button.first().click()
  } else {
    await clickVisibleTextPrefix(page, `${label} `, `${label} time dropdown`)
  }
  await page.waitForTimeout(500)

  const option = page.getByRole('button', { name: time, exact: true })
  const count = await option.count()
  if (count) {
    await option.nth(count - 1).click()
  } else {
    await clickVisibleText(page, time, `${label} time option ${time}`)
  }
  await page.waitForTimeout(800)
}

async function clickVisibleTextPrefix(page, textPrefix, label) {
  const clickTarget = await page.evaluate((prefix) => {
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
      .filter((item) => item.visible && item.text.startsWith(prefix))
      .sort((a, b) => a.area - b.area)
    return matches[0] || null
  }, textPrefix)

  if (!clickTarget) {
    const screenshot = await saveScreenshot(page, 'modify-visible-prefix-not-found')
    throw new Error(`Could not find visible ${label} on ${target.date}. Screenshot: ${screenshot}`)
  }
  await page.mouse.click(clickTarget.x, clickTarget.y)
}

async function clickSaveChanges(page) {
  const exact = page.getByRole('button', { name: 'Save changes', exact: true })
  if (await exact.count()) {
    await log('Clicking Save changes.')
    await exact.last().click()
    return
  }

  const review = page.getByRole('button', { name: /Review and save/i })
  if (await review.count()) {
    await log('Clicking Review and save.')
    await review.first().click()
    await page.waitForTimeout(800)
    const save = page.getByRole('button', { name: /Save changes|Confirm/i })
    if (await save.count()) {
      await save.last().click()
      return
    }
  }

  throw new Error('Could not find Save changes button.')
}

async function waitForModifyResult(page) {
  const deadline = Date.now() + Number(process.env.SKEDDA_MODIFY_WAIT_MS || 15_000)
  while (Date.now() < deadline) {
    const text = await visibleText(page).catch(() => '')
    if (/saved|updated|too easy|booking is in|couldn|sorry|error|failed|not available|conflict/i.test(text)) return
    if (isModifySuccess(text)) return
    await page.waitForTimeout(800)
  }
}

function isModifySuccess(text) {
  const normalized = normalizeText(text)
  return normalized.includes(`${targetStart}–${targetEnd}`) || normalized.includes(`${targetStart}-${targetEnd}`)
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

async function dismissUsagePrompt(page) {
  const decline = page.getByRole('button', { name: 'Decline', exact: true })
  if (await decline.count()) {
    await decline.first().click().catch(() => {})
    await page.waitForTimeout(500)
  }
}

async function clickVisibleText(page, textToFind, label) {
  const clickTarget = await page.evaluate((name) => {
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

  if (!clickTarget) {
    const screenshot = await saveScreenshot(page, 'modify-visible-text-not-found')
    throw new Error(`Could not find visible ${label} on ${target.date}. Screenshot: ${screenshot}`)
  }
  await page.mouse.click(clickTarget.x, clickTarget.y)
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

function stampForFilename(date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function clipText(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...` : text
}

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
