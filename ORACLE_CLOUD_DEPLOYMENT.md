# Oracle Cloud Always Free deployment

This deploys the existing step-by-step Telegram invoice bot as a continuously running Node.js worker. It uses Telegram long polling, so no public webhook URL is required.

## Important

- Do not disable the GitHub Actions polling workflow until the Oracle worker has been configured and tested. Two pollers using the same bot token will conflict.
- The worker requires the primary bot token, the Telegram user allowlist, and the Notion integration credentials.
- Never commit secrets to this repository or send them in chat.
- Oracle Always Free capacity is subject to regional availability and Oracle's eligibility/idle-resource policies. This is a free-tier target, not a guarantee of uninterrupted service.
- The invoice PDF renderer uses Playwright Chromium. Install the browser and OS dependencies as shown below.

## 1. Create the VM

In Oracle Cloud, create an Ubuntu 22.04 or 24.04 VM in an Always Free eligible shape/region. Prefer an Ampere A1 shape with enough memory for Chromium, if available in your tenancy. Assign a public IPv4 address and configure the network security list to allow SSH (TCP 22). The bot itself needs outbound HTTPS; it does not need an inbound Telegram port.

## 2. Install Node.js and fetch the project

SSH into the VM, then run:

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

Clone the repository and install dependencies:

```bash
git clone https://github.com/Iman-Rashidi/Online-Rechnungsgenerator.git
cd Online-Rechnungsgenerator/telegram-mcp
npm ci
npx playwright install --with-deps chromium
```

If `npm ci` reports that no lockfile exists, use `npm install` instead.

## 3. Configure secrets

Create a protected environment file:

```bash
sudo install -o "$USER" -g "$USER" -m 700 -d /etc/rechnio
sudo nano /etc/rechnio/rechnio.env
```

Add the values locally (do not paste them into GitHub or chat):

```dotenv
TELEGRAM_BOT_TOKEN=your_primary_bot_token
TELEGRAM_ALLOWED_USER_IDS=your_telegram_numeric_user_id
NOTION_API_KEY=your_notion_integration_secret
NOTION_DATA_SOURCE_ID=your_notion_data_source_id
STATE_FILE=/var/lib/rechnio/telegram-updates.json
```

Save, then secure the file:

```bash
sudo chown root:root /etc/rechnio/rechnio.env
sudo chmod 600 /etc/rechnio/rechnio.env
sudo install -o "$USER" -g "$USER" -m 700 -d /var/lib/rechnio
```

Use the same Notion data source ID already verified by the repository's GitHub Actions workflow. Do not guess a database ID in its place.

## 4. Install the systemd service

Replace `YOUR_LINUX_USERNAME` below with the Linux username used to clone the repository:

```bash
sudo nano /etc/systemd/system/rechnio.service
```

Paste and adjust the paths/user:

```ini
[Unit]
Description=Rechnio Telegram invoice bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_LINUX_USERNAME
WorkingDirectory=/home/YOUR_LINUX_USERNAME/Online-Rechnungsgenerator/telegram-mcp
EnvironmentFile=/etc/rechnio/rechnio.env
ExecStart=/usr/bin/npm run start:oracle
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rechnio
sudo systemctl status rechnio
journalctl -u rechnio -f
```

## 5. Cut over safely

Only after the service is active and a test invoice has been delivered:

1. Stop or disable the scheduled GitHub Actions workflow `.github/workflows/telegram-bot-polling.yml` so it no longer polls the same bot token.
2. Confirm the Oracle worker continues receiving messages after an SSH disconnect and after a VM reboot.
3. Keep the state file directory backed up. The wizard conversation state and Telegram update offset are stored there.

## Troubleshooting

- If startup says a webhook is active, remove it before using polling. Telegram does not allow getUpdates polling and a webhook at the same time.
- If Chromium fails to launch, rerun `npx playwright install --with-deps chromium` and inspect `journalctl -u rechnio`.
- Check `systemctl status rechnio` and `journalctl -u rechnio -n 100` for worker errors.
- The GitHub Actions workflow remains the fallback until the cutover is verified.
