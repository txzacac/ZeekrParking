# Zeekr Skedda Parking Bot

Automates Zeekr Skedda parking booking, optional booking modification, and daily check-in with email notifications.

The project does not store your Skedda password. It reuses a local Playwright/Chromium profile after you complete SSO manually once.

## Requirements

- Windows 10/11
- Node.js 20+
- PowerShell
- A Skedda account that can access the target booking page
- Optional: Gmail app password or SMTP account for email notifications

## Install

```powershell
git clone https://github.com/txzacac/ZeekrParking.git
cd ZeekrParking
npm install
npx playwright install chromium
Copy-Item .env.example .env
notepad .env
```

Fill in your own values in `.env`.

## Important Configuration

Email notification:

```env
GMAIL_USER=your.name@gmail.com
GMAIL_APP_PASSWORD=your-gmail-app-password
MAIL_TO=xxxx@geely.com
```

Booking time:

```env
SKEDDA_START_TIME=07:30
SKEDDA_END_TIME=18:00
SKEDDA_CLICK_TIME=07:30
```

Parking priority order:

```env
SKEDDA_PREFERRED_SPACES=12,13,14,15,16,17,18,19,20,21,22,23,24,25
```

Mad mode opens several tabs in parallel, prepares booking drafts, then confirms them one by one:

```env
SKEDDA_MAD_MODE=true
SKEDDA_MAD_PARALLEL_SPACES=12,13,14
SKEDDA_MAD_PARALLEL_LIMIT=3
```

Vehicle and user details:

```env
SKEDDA_CAR_MAKE=your car make
SKEDDA_CAR_MODEL=your car model
SKEDDA_LICENSE_PLATE=YOUR-PLATE
SKEDDA_CHECKIN_NAME=Your Name
```

## First Login

Run this once and complete SSO in the browser window:

```powershell
npm run skedda:login
```

After login succeeds, the local `.skedda-profile` folder stores the browser session. It is ignored by Git.

## Manual Runs

Booking:

```powershell
npm run skedda:book
```

Mad mode booking:

```powershell
npm run skedda:book:mad
```

Modify existing booking:

```powershell
npm run skedda:modify
```

Check in:

```powershell
npm run skedda:checkin
```

Dry run without confirming:

```powershell
$env:SKEDDA_DRY_RUN="true"
npm run skedda:book:mad
Remove-Item Env:SKEDDA_DRY_RUN -ErrorAction SilentlyContinue
```

## Windows Scheduled Tasks

Register booking task. This prepares the page before the booking time and retries once.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-skedda-task.ps1 `
  -MadMode `
  -PrepareTime 07:28 `
  -RetryTime 07:31 `
  -SundayRetryEnabled $true `
  -SundayRetryTime 12:00
```

Register modify task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-skedda-modify-task.ps1 -TriggerTime 09:30
```

Register check-in task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-skedda-checkin-task.ps1 -TriggerTime 08:05
```

The scheduled tasks set `WakeToRun=true`, but Windows can only wake the PC if the machine, BIOS/UEFI, power plan, and network/power state allow wake timers.

## Logs

Logs and screenshots are written to:

```text
logs/skedda/
```

These files are ignored by Git.

## Safety Notes

- Do not commit `.env`, `.skedda-profile`, or `logs/`.
- The bot clicks real Skedda booking buttons unless `SKEDDA_DRY_RUN=true`.
- Test with a short time window first if you are adapting this for a new Skedda map.
