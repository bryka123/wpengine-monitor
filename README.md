# WP Engine Domain Monitor

A dashboard that monitors all your WP Engine sites and checks if domains have DNS properly pointed to WP Engine servers.

Shows you at a glance which domains are **GOOD** (pointed correctly) and which have **ISSUES** (not pointed, not resolving, or pointed elsewhere).

## Quick Start

### 1. Install dependencies

```bash
cd wpengine-api
npm install
```

### 2. Get your WP Engine API credentials

Go to [my.wpengine.com/api_access](https://my.wpengine.com/api_access) and create API credentials (username + password).

### 3. Run the dashboard

```bash
node server.js YOUR_API_USER YOUR_API_PASS
```

### 4. Open in browser

Go to **http://localhost:4782**

The dashboard will automatically load all your sites and run DNS checks. Click the **Refresh** button anytime to pull fresh data.

## What It Checks

For each domain across all your WP Engine installs:

- **WP Engine API status** — uses the API's `network_info.status` as the source of truth (ACTIVE, PENDING, DELETED)
- **Live DNS lookup** — resolves A records and CNAMEs via your system DNS
- **WP Engine IP matching** — verifies DNS points to known WP Engine IPs (141.193.213.x, 35.203.43.x, 172.64.80.x)
- **CNAME matching** — checks for `*.wpeproxy.com`, `*.wpengine.com`, `*.wpenginepowered.com` CNAMEs
- **SSL status** — shows active, expired, or pending validation

## Features

- Monitors all installs and domains across your WP Engine account
- Search by site name or domain
- Filter by All / Issues / Good
- Issues auto-expand when filtering
- Shows SSL status per domain
- Refresh button for live data updates
- Progress indicator during refresh

## Static Dashboard (Alternative)

If you don't want to run a server, you can generate a static HTML file:

```bash
node generate-dashboard.js YOUR_API_USER YOUR_API_PASS
```

This creates `dashboard.html` that you can open directly in your browser. No refresh button though — re-run the command to update.

## Environment Variables

Instead of passing credentials as arguments, you can use environment variables:

```bash
export WPE_API_USER=your-api-username
export WPE_API_PASS=your-api-password
node server.js
```

## Port

Default port is **4782**. Change it with:

```bash
PORT=8080 node server.js YOUR_API_USER YOUR_API_PASS
```
