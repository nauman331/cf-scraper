#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="cf-scraper"
APP_PORT="${APP_PORT:-4173}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="${APP_NAME}.service"
NGINX_SITE="$APP_NAME"

if [[ ! -f "$APP_DIR/package.json" ]]; then
    echo "Error: package.json was not found in $APP_DIR"
    echo "Place deploy.sh in the project root and run it there."
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    echo "Error: Node.js is not installed."
    echo "Install Node.js 18 or newer, then rerun this script."
    exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"

if (( NODE_MAJOR < 18 )); then
    echo "Error: Node.js 18 or newer is required. Current version: $(node --version)"
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is not installed."
    exit 1
fi

# Use the person who invoked sudo, not root, to run the application.
APP_USER="${SUDO_USER:-$USER}"

if ! id "$APP_USER" >/dev/null 2>&1; then
    echo "Error: Linux user '$APP_USER' does not exist."
    exit 1
fi

APP_GROUP="$(id -gn "$APP_USER")"
NPM_BIN="$(command -v npm)"

echo "Application directory: $APP_DIR"
echo "Application user:      $APP_USER"
echo "Node.js version:       $(node --version)"
echo "Application port:      $APP_PORT"

echo
echo "Installing Linux dependencies..."
sudo apt-get update
sudo apt-get install -y \
    build-essential \
    python3 \
    curl \
    ca-certificates \
    gnupg \
    nginx \
    apache2-utils

detect_chrome() {
    local candidate

    for candidate in \
        /usr/bin/google-chrome-stable \
        /usr/bin/google-chrome \
        /usr/bin/chromium \
        /usr/bin/chromium-browser; do
        if [[ -x "$candidate" ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    return 1
}

CHROME_PATH="$(detect_chrome || true)"

if [[ -z "$CHROME_PATH" ]]; then
    ARCH="$(dpkg --print-architecture)"

    if [[ "$ARCH" != "amd64" ]]; then
        echo "Error: Automatic Google Chrome installation supports amd64 only."
        echo "Install Chromium manually and rerun this script."
        exit 1
    fi

    echo "Installing Google Chrome..."
    TEMP_DEB="$(mktemp --suffix=.deb)"

    curl -fsSL \
        https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
        -o "$TEMP_DEB"

    sudo apt-get install -y "$TEMP_DEB"
    rm -f "$TEMP_DEB"

    CHROME_PATH="$(detect_chrome || true)"
fi

if [[ -z "$CHROME_PATH" ]]; then
    echo "Error: Chrome or Chromium could not be found."
    exit 1
fi

echo "Browser executable: $CHROME_PATH"

echo
echo "Installing Node.js dependencies..."
cd "$APP_DIR"

if [[ -f package-lock.json ]]; then
    sudo -u "$APP_USER" "$NPM_BIN" ci --omit=dev
else
    sudo -u "$APP_USER" "$NPM_BIN" install --omit=dev
fi

sudo mkdir -p "$APP_DIR/data"
sudo chown -R "$APP_USER:$APP_GROUP" "$APP_DIR/data"

echo
echo "Creating systemd service..."

sudo tee "/etc/systemd/system/$SERVICE_NAME" >/dev/null <<EOF
[Unit]
Description=Similarweb Scraper GUI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$APP_DIR
ExecStart=$NPM_BIN run gui
Environment=NODE_ENV=production
Environment=GUI_PORT=$APP_PORT
Environment=GUI_NO_OPEN=true
Environment=CHROME_PATH=$CHROME_PATH
Environment=HEADLESS=true
Environment=SCRAPER_TIMEOUT_MS=90000
Environment=MAX_PROXY_ATTEMPTS=10
Environment=MIN_REQUEST_DELAY_MS=2000
Environment=MAX_REQUEST_DELAY_MS=6000
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGINT

# Chrome may require more open files during scraping.
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

echo
echo "Configure login protection for the web interface."
read -rp "Web username [admin]: " WEB_USER
WEB_USER="${WEB_USER:-admin}"

while true; do
    read -rsp "Web password: " WEB_PASSWORD
    echo

    if [[ ${#WEB_PASSWORD} -lt 8 ]]; then
        echo "Password must contain at least 8 characters."
        continue
    fi

    read -rsp "Confirm password: " WEB_PASSWORD_CONFIRM
    echo

    if [[ "$WEB_PASSWORD" == "$WEB_PASSWORD_CONFIRM" ]]; then
        break
    fi

    echo "Passwords do not match. Try again."
done

sudo htpasswd -bc "/etc/nginx/.htpasswd-$APP_NAME" \
    "$WEB_USER" "$WEB_PASSWORD"

unset WEB_PASSWORD WEB_PASSWORD_CONFIRM

echo
echo "Creating Nginx configuration..."

sudo tee "/etc/nginx/sites-available/$NGINX_SITE" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;

    server_name _;

    auth_basic "Private scraper";
    auth_basic_user_file /etc/nginx/.htpasswd-$APP_NAME;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;

        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Required for the GUI's live Server-Sent Events.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF

sudo ln -sfn \
    "/etc/nginx/sites-available/$NGINX_SITE" \
    "/etc/nginx/sites-enabled/$NGINX_SITE"

sudo rm -f /etc/nginx/sites-enabled/default

echo
echo "Testing and starting services..."
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"
sudo systemctl enable --now nginx
sudo systemctl reload nginx

echo
echo "Checking application status..."
sleep 2

if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "Deployment completed successfully."
else
    echo "The application failed to start."
    echo
    sudo journalctl -u "$SERVICE_NAME" --no-pager -n 50
    exit 1
fi

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

echo
echo "Open the application at:"
echo "  http://${SERVER_IP:-YOUR_VPS_IP}"
echo
echo "Username: $WEB_USER"
echo
echo "Useful commands:"
echo "  sudo systemctl status $SERVICE_NAME"
echo "  sudo systemctl restart $SERVICE_NAME"
echo "  sudo journalctl -u $SERVICE_NAME -f"