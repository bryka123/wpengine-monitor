#!/usr/bin/env node
/**
 * WP Engine Domain Monitor — Live Server
 *
 * Serves the dashboard and provides a /api/refresh endpoint
 * so data can be refreshed from the browser.
 *
 * Usage:
 *   node server.js <API_USER> <API_PASS>
 *   node server.js  (uses env vars WPE_API_USER / WPE_API_PASS)
 *
 * Then open http://localhost:3000
 */

const express = require("express");
const fetch = require("node-fetch");
const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4782;
const API_BASE = "https://api.wpengineapi.com/v1";

const WPE_CNAME_SUFFIXES = [".wpengine.com", ".wpenginepowered.com", ".wpesvc.net", ".wpeproxy.com"];
const WPE_IP_PREFIXES = ["141.193.213.", "35.203.43.", "172.64.80."];

const user = process.argv[2] || process.env.WPE_API_USER;
const pass = process.argv[3] || process.env.WPE_API_PASS;
if (!user || !pass) {
  console.error("Usage: node server.js <API_USER> <API_PASS>");
  process.exit(1);
}

const headers = {
  Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
  "Content-Type": "application/json",
};

// ── Confirmed domains persistence ────────────────────────────
const CONFIRMED_FILE = path.join(__dirname, "confirmed.json");

function loadConfirmed() {
  try {
    if (fs.existsSync(CONFIRMED_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIRMED_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function saveConfirmed(data) {
  fs.writeFileSync(CONFIRMED_FILE, JSON.stringify(data, null, 2));
}

// Key = domain name, value = { confirmedAt, note }
let confirmedDomains = loadConfirmed();

// ── Cached data ──────────────────────────────────────────────
let cachedData = null;
let isRefreshing = false;
let refreshProgress = "";

// ── API helpers ──────────────────────────────────────────────

async function apiFetch(urlPath) {
  const res = await fetch(`${API_BASE}${urlPath}`, { headers });
  if (!res.ok) throw new Error(`API ${res.status} on ${urlPath}`);
  return res.json();
}

async function fetchAllInstalls() {
  let all = [];
  let offset = 0;
  while (true) {
    const data = await apiFetch(`/installs?limit=100&offset=${offset}`);
    all = all.concat(data.results || []);
    if (!data.next) break;
    offset += 100;
  }
  return all;
}

async function fetchDomains(installId) {
  try {
    const data = await apiFetch(`/installs/${installId}/domains?limit=100`);
    return data.results || [];
  } catch {
    return [];
  }
}

async function dnsLookup(domain) {
  const result = { ips: [], cnames: [], resolved: false };
  try { result.ips = await dns.resolve4(domain); result.resolved = true; } catch {}
  try { result.cnames = await dns.resolveCname(domain); result.resolved = result.resolved || result.cnames.length > 0; } catch {}
  return result;
}

function dnsPointsToWPE(dnsResult, installCname, allDomainNames) {
  if (!dnsResult || !dnsResult.resolved) return false;
  if (dnsResult.cnames.length > 0) {
    if (dnsResult.cnames.some((c) => WPE_CNAME_SUFFIXES.some((s) => c.endsWith(s)) || c === installCname)) return true;
    if (allDomainNames && dnsResult.cnames.some((c) => allDomainNames.has(c))) return true;
  }
  if (dnsResult.ips.length > 0) {
    if (dnsResult.ips.some((ip) => WPE_IP_PREFIXES.some((p) => ip.startsWith(p)))) return true;
  }
  return false;
}

async function batchAsync(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

function determineDomainStatus(domain, dnsResult, installCname, allDomainNames) {
  const isSystem = domain.name.endsWith(".wpenginepowered.com") || domain.name.endsWith(".wpengine.com");
  if (isSystem) return { status: "system", detail: "System domain" };

  const networkStatus = domain.network_details?.network_info?.status?.toUpperCase();
  const expectedCname = domain.network_details?.dns_config_info?.cname || null;
  const expectedARecords = domain.network_details?.dns_config_info?.a_records || [];
  const dnsMatches = dnsResult ? dnsPointsToWPE(dnsResult, installCname, allDomainNames) : false;

  let dnsMatchesExpected = false;
  if (dnsResult && dnsResult.ips.length > 0 && expectedARecords.length > 0) {
    dnsMatchesExpected = dnsResult.ips.some((ip) => expectedARecords.includes(ip));
  }
  let cnameMatchesExpected = false;
  if (dnsResult && dnsResult.cnames.length > 0 && expectedCname) {
    cnameMatchesExpected = dnsResult.cnames.some((c) => c === expectedCname);
  }

  if (networkStatus === "ACTIVE") {
    if (dnsMatches || dnsMatchesExpected || cnameMatchesExpected) return { status: "good", detail: "Active & DNS pointed" };
    if (dnsResult && dnsResult.resolved) return { status: "issue", detail: "DNS not pointed to WPE" };
    if (dnsResult && !dnsResult.resolved) return { status: "issue", detail: "DNS not resolving" };
    return { status: "good", detail: "Active (API)" };
  }
  if (networkStatus === "PENDING") return { status: "pending", detail: "Pending setup" };
  if (networkStatus === "DELETED") return { status: "issue", detail: "Network deleted" };

  if (!networkStatus) {
    if (dnsMatches) return { status: "good", detail: "DNS pointed (Legacy)" };
    if (dnsResult && dnsResult.resolved) return { status: "issue", detail: "DNS not pointed to WPE" };
    if (dnsResult && !dnsResult.resolved) return { status: "issue", detail: "DNS not resolving" };
    return { status: "unknown", detail: "No status data" };
  }
  return { status: "unknown", detail: networkStatus || "Unknown" };
}

// ── Data fetching ────────────────────────────────────────────

async function refreshData() {
  if (isRefreshing) {
    // Wait for the in-progress refresh to finish instead of returning null
    await new Promise(function (resolve) {
      var check = setInterval(function () {
        if (!isRefreshing) { clearInterval(check); resolve(); }
      }, 500);
    });
    return cachedData;
  }
  isRefreshing = true;
  refreshProgress = "Fetching installs...";

  try {
    const installs = await fetchAllInstalls();
    refreshProgress = `Fetching domains for ${installs.length} installs...`;

    const installDomains = await batchAsync(installs, 10, async (inst) => {
      const domains = await fetchDomains(inst.id);
      return { install: inst, domains };
    });

    const allDomainNames = new Set();
    for (const { domains } of installDomains) {
      for (const d of domains) allDomainNames.add(d.name);
    }

    const allCustomDomains = [];
    for (const { install, domains } of installDomains) {
      for (const d of domains) {
        if (!d.name.endsWith(".wpenginepowered.com") && !d.name.endsWith(".wpengine.com")) {
          allCustomDomains.push({ ...d, _installCname: install.cname });
        }
      }
    }

    refreshProgress = `DNS checks on ${allCustomDomains.length} domains...`;
    const dnsResults = {};
    let done = 0;
    await batchAsync(allCustomDomains, 30, async (d) => {
      const result = await dnsLookup(d.name);
      dnsResults[d.id] = result;
      done++;
      if (done % 50 === 0) refreshProgress = `DNS: ${done}/${allCustomDomains.length}`;
      return result;
    });

    const siteData = installDomains.map(({ install, domains }) => {
      const enrichedDomains = domains.map((d) => {
        const isSystem = d.name.endsWith(".wpenginepowered.com") || d.name.endsWith(".wpengine.com");
        const dnsResult = dnsResults[d.id] || null;
        const { status, detail } = determineDomainStatus(d, dnsResult, install.cname, allDomainNames);
        return {
          name: d.name, id: d.id, primary: d.primary,
          network_type: d.network_type || "", redirect_to: d.redirect_to?.name || null,
          isSystem, dns: dnsResult, status, detail,
          sslStatus: d.network_details?.network_info?.ssl?.status || null,
          expectedCname: d.network_details?.dns_config_info?.cname || null,
          expectedARecords: d.network_details?.dns_config_info?.a_records || [],
        };
      });
      const custom = enrichedDomains.filter((d) => !d.isSystem);
      return {
        name: install.name, id: install.id, environment: install.environment,
        primary_domain: install.primary_domain, cname: install.cname,
        php_version: install.php_version, domains: enrichedDomains,
        issueCount: custom.filter((d) => d.status === "issue").length,
        pendingCount: custom.filter((d) => d.status === "pending").length,
      };
    });

    const allDomains = siteData.flatMap((s) => s.domains);
    const customDomains = allDomains.filter((d) => !d.isSystem);

    cachedData = {
      sites: siteData,
      stats: {
        totalSites: installs.length, totalDomains: allDomains.length,
        customDomains: customDomains.length,
        good: customDomains.filter((d) => d.status === "good").length,
        issues: customDomains.filter((d) => d.status === "issue").length,
        pending: customDomains.filter((d) => d.status === "pending").length,
        timestamp: new Date().toISOString(),
      },
    };
    refreshProgress = "";
    return cachedData;
  } finally {
    isRefreshing = false;
  }
}

// ── Routes ───────────────────────────────────────────────────

function applyConfirmedOverrides(data) {
  if (!data || !data.sites) return data;
  let confirmedCount = 0;
  const sites = data.sites.map(site => {
    const domains = site.domains.map(d => {
      if (d.status === "issue" && confirmedDomains[d.name]) {
        confirmedCount++;
        return { ...d, status: "confirmed", originalStatus: "issue", originalDetail: d.detail, detail: "Confirmed OK", confirmedAt: confirmedDomains[d.name].confirmedAt };
      }
      return d;
    });
    const custom = domains.filter(d => !d.isSystem);
    return {
      ...site, domains,
      issueCount: custom.filter(d => d.status === "issue").length,
      confirmedCount: custom.filter(d => d.status === "confirmed").length,
    };
  });
  const allDomains = sites.flatMap(s => s.domains);
  const customDomains = allDomains.filter(d => !d.isSystem);
  return {
    sites,
    stats: {
      ...data.stats,
      good: customDomains.filter(d => d.status === "good").length,
      issues: customDomains.filter(d => d.status === "issue").length,
      confirmed: customDomains.filter(d => d.status === "confirmed").length,
      pending: customDomains.filter(d => d.status === "pending").length,
    },
  };
}

app.use(express.json());

app.get("/api/data", (req, res) => {
  if (cachedData) return res.json(applyConfirmedOverrides(cachedData));
  res.json({ sites: [], stats: null });
});

app.get("/api/refresh", async (req, res) => {
  try {
    const data = await refreshData();
    res.json(applyConfirmedOverrides(data));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/confirm", (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: "domain is required" });
  confirmedDomains[domain] = { confirmedAt: new Date().toISOString() };
  saveConfirmed(confirmedDomains);
  res.json({ ok: true, domain, confirmed: true });
});

app.delete("/api/confirm", (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: "domain is required" });
  delete confirmedDomains[domain];
  saveConfirmed(confirmedDomains);
  res.json({ ok: true, domain, confirmed: false });
});

app.get("/api/status", (req, res) => {
  res.json({ refreshing: isRefreshing, progress: refreshProgress, hasData: !!cachedData });
});

app.get("/", (req, res) => {
  res.send(DASHBOARD_HTML);
});

// ── Dashboard HTML ───────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WP Engine Domain Monitor</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #030712; color: #e5e7eb; min-height: 100vh; }

  .header { background: rgba(17,24,39,.9); border-bottom: 1px solid #1f2937; padding: 16px 24px; position: sticky; top: 0; z-index: 10; backdrop-filter: blur(8px); }
  .header-inner { max-width: 1280px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  .header-left { display: flex; align-items: center; gap: 12px; }
  .logo { width: 36px; height: 36px; border-radius: 10px; background: #4f46e5; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 16px; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header .meta { font-size: 11px; color: #6b7280; }
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .search { background: #1f2937; border: 1px solid #374151; border-radius: 8px; padding: 6px 12px; color: #e5e7eb; font-size: 13px; width: 220px; outline: none; }
  .search:focus { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,.3); }
  .filter-group { display: flex; background: #1f2937; border: 1px solid #374151; border-radius: 8px; overflow: hidden; }
  .filter-btn { padding: 6px 14px; font-size: 12px; background: transparent; border: none; color: #9ca3af; cursor: pointer; transition: all .15s; }
  .filter-btn:hover { color: #e5e7eb; }
  .filter-btn.active { background: #4f46e5; color: #fff; }
  .refresh-btn { background: #4f46e5; border: none; color: #fff; padding: 6px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all .15s; display: flex; align-items: center; gap: 6px; }
  .refresh-btn:hover { background: #4338ca; }
  .refresh-btn:disabled { background: #374151; color: #6b7280; cursor: not-allowed; }
  .refresh-btn .spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; border-radius: 50%; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .content { max-width: 1280px; margin: 0 auto; padding: 20px 24px; }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 16px; }
  .stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #6b7280; margin-bottom: 4px; }
  .stat-value { font-size: 28px; font-weight: 700; }
  .c-white { color: #e5e7eb; } .c-blue { color: #60a5fa; } .c-indigo { color: #818cf8; }
  .c-green { color: #34d399; } .c-red { color: #f87171; } .c-amber { color: #fbbf24; } .c-teal { color: #2dd4bf; }

  .site-card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; margin-bottom: 10px; overflow: hidden; }
  .site-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; cursor: pointer; transition: background .15s; user-select: none; }
  .site-header:hover { background: rgba(31,41,55,.5); }
  .site-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot-green { background: #34d399; } .dot-red { background: #f87171; } .dot-gray { background: #4b5563; } .dot-amber { background: #fbbf24; }
  .site-name { font-weight: 600; font-size: 14px; }
  .badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 500; border: 1px solid; white-space: nowrap; }
  .b-gray { background: #1f2937; color: #9ca3af; border-color: #374151; }
  .b-green { background: rgba(6,78,59,.4); color: #6ee7b7; border-color: #065f46; }
  .b-red { background: rgba(127,29,29,.4); color: #fca5a5; border-color: #7f1d1d; }
  .b-amber { background: rgba(120,53,15,.4); color: #fcd34d; border-color: #78350f; }
  .b-blue { background: rgba(30,58,138,.4); color: #93c5fd; border-color: #1e3a8a; }
  .chevron { width: 16px; height: 16px; color: #6b7280; transition: transform .2s; flex-shrink: 0; }
  .chevron.open { transform: rotate(180deg); }
  .primary-domain { color: #6b7280; font-size: 12px; }

  .domain-table { width: 100%; border-collapse: collapse; border-top: 1px solid #1f2937; }
  .domain-table th { padding: 8px 16px; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; text-align: left; background: rgba(17,24,39,.5); }
  .domain-table td { padding: 10px 16px; border-top: 1px solid rgba(31,41,55,.5); font-size: 13px; vertical-align: middle; }
  .domain-table tr:hover td { background: rgba(31,41,55,.3); }
  .domain-name { display: flex; align-items: center; gap: 6px; }
  .d-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
  .system-name { color: #6b7280; }
  .redirect { color: #4b5563; font-size: 11px; }
  .resolves-to { color: #6b7280; font-size: 11px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .verdict { font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 6px; }
  .v-good { color: #34d399; } .v-issue { color: #f87171; } .v-pending { color: #fbbf24; } .v-na { color: #4b5563; } .v-confirmed { color: #2dd4bf; }
  .b-teal { background: rgba(13,148,136,.3); color: #5eead4; border-color: #0d9488; }
  .confirm-btn { padding: 2px 8px; border-radius: 6px; font-size: 10px; font-weight: 600; cursor: pointer; border: 1px solid; transition: all .15s; }
  .confirm-btn.mark { background: rgba(13,148,136,.2); color: #5eead4; border-color: #0d9488; }
  .confirm-btn.mark:hover { background: rgba(13,148,136,.4); }
  .confirm-btn.unmark { background: rgba(127,29,29,.2); color: #fca5a5; border-color: #7f1d1d; }
  .confirm-btn.unmark:hover { background: rgba(127,29,29,.4); }

  .count-info { font-size: 11px; color: #6b7280; margin-bottom: 12px; }
  .no-match { text-align: center; padding: 48px; color: #4b5563; }
  .hidden { display: none !important; }
  .loading-screen { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 80px 20px; }
  .loading-screen .big-spinner { width: 40px; height: 40px; border: 3px solid #1f2937; border-top-color: #6366f1; border-radius: 50%; animation: spin .8s linear infinite; margin-bottom: 16px; }
  .loading-screen p { color: #6b7280; font-size: 14px; }
</style>
</head>
<body>

<div class="header">
  <div class="header-inner">
    <div class="header-left">
      <div class="logo">W</div>
      <div>
        <h1>WP Engine Domain Monitor</h1>
        <div class="meta" id="timestamp">Loading...</div>
      </div>
    </div>
    <div class="controls">
      <input class="search" type="text" placeholder="Search sites or domains..." id="searchInput">
      <div class="filter-group">
        <button class="filter-btn active" data-filter="all">All</button>
        <button class="filter-btn" data-filter="issues">Issues</button>
        <button class="filter-btn" data-filter="confirmed">Confirmed</button>
        <button class="filter-btn" data-filter="good">Good</button>
      </div>
      <button class="refresh-btn" id="refreshBtn" onclick="doRefresh()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
        <span id="refreshLabel">Refresh</span>
      </button>
    </div>
  </div>
</div>

<div class="content">
  <div class="stats" id="statsBar"></div>
  <div class="count-info" id="countInfo"></div>
  <div id="siteList"></div>
  <div class="no-match hidden" id="noMatch">No sites match your filters.</div>
  <div class="loading-screen" id="loadingScreen">
    <div class="big-spinner"></div>
    <p id="loadingText">Connecting to WP Engine API...</p>
  </div>
</div>

<script>
let DATA = [];
let STATS = null;
let currentFilter = "all", currentSearch = "";
let refreshing = false;

function esc(s) { return s ? s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") : ""; }

function renderStats() {
  if (!STATS) { document.getElementById("statsBar").innerHTML = ""; return; }
  const s = STATS;
  document.getElementById("statsBar").innerHTML =
    '<div class="stat"><div class="stat-label">Sites</div><div class="stat-value c-white">'+s.totalSites+'</div></div>' +
    '<div class="stat"><div class="stat-label">Total Domains</div><div class="stat-value c-blue">'+s.totalDomains+'</div></div>' +
    '<div class="stat"><div class="stat-label">Custom Domains</div><div class="stat-value c-indigo">'+s.customDomains+'</div></div>' +
    '<div class="stat"><div class="stat-label">Good</div><div class="stat-value c-green">'+s.good+'</div></div>' +
    '<div class="stat"><div class="stat-label">Issues</div><div class="stat-value '+(s.issues>0?'c-red':'c-green')+'">'+s.issues+'</div></div>' +
    '<div class="stat"><div class="stat-label">Confirmed</div><div class="stat-value c-teal">'+(s.confirmed||0)+'</div></div>' +
    '<div class="stat"><div class="stat-label">Pending</div><div class="stat-value c-amber">'+s.pending+'</div></div>';
  document.getElementById("timestamp").textContent = "Updated " + new Date(s.timestamp).toLocaleString();
}

function renderSites() {
  const el = document.getElementById("siteList");
  const q = currentSearch.toLowerCase();

  const filtered = DATA.filter(site => {
    if (q) {
      if (!site.name.toLowerCase().includes(q) &&
          !(site.primary_domain||"").toLowerCase().includes(q) &&
          !site.domains.some(d => d.name.toLowerCase().includes(q))) return false;
    }
    if (currentFilter === "all") return true;
    if (currentFilter === "issues") return site.issueCount > 0;
    if (currentFilter === "confirmed") return (site.confirmedCount || 0) > 0;
    return site.issueCount === 0 && (site.confirmedCount || 0) === 0;
  });

  document.getElementById("countInfo").textContent = "Showing " + filtered.length + " of " + DATA.length + " sites";
  document.getElementById("noMatch").classList.toggle("hidden", filtered.length > 0);

  el.innerHTML = filtered.map(site => {
    const dotCls = site.issueCount > 0 ? "dot-red" : (site.confirmedCount||0) > 0 ? "dot-amber" : site.domains.filter(d=>!d.isSystem&&(d.status==="good"||d.status==="confirmed")).length === site.domains.filter(d=>!d.isSystem).length && site.domains.filter(d=>!d.isSystem).length > 0 ? "dot-green" : "dot-gray";
    const autoOpen = (currentFilter === "issues" && site.issueCount > 0) || (currentFilter === "confirmed" && (site.confirmedCount||0) > 0);

    return '<div class="site-card">' +
      '<div class="site-header">' +
        '<div class="site-left">' +
          '<div class="dot ' + dotCls + '"></div>' +
          '<span class="site-name">' + esc(site.name) + '</span>' +
          '<span class="badge b-gray">' + esc(site.environment) + '</span>' +
          (site.primary_domain ? '<span class="primary-domain">' + esc(site.primary_domain) + '</span>' : '') +
          '<span class="badge b-gray">' + site.domains.length + ' domains</span>' +
          (site.issueCount > 0 ? '<span class="badge b-red">' + site.issueCount + ' issue' + (site.issueCount!==1?'s':'') + '</span>' : '') +
          ((site.confirmedCount||0) > 0 ? '<span class="badge b-teal">' + site.confirmedCount + ' confirmed</span>' : '') +
          (site.pendingCount > 0 ? '<span class="badge b-amber">' + site.pendingCount + ' pending</span>' : '') +
          (site.issueCount === 0 && (site.confirmedCount||0) === 0 && site.pendingCount === 0 && site.domains.filter(d=>!d.isSystem).length > 0 ? '<span class="badge b-green">All good</span>' : '') +
        '</div>' +
        '<svg class="chevron' + (autoOpen ? ' open' : '') + '" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>' +
      '</div>' +
      '<table class="domain-table" style="display:' + (autoOpen ? 'table' : 'none') + '">' +
        '<thead><tr><th>Domain</th><th>Network</th><th>DNS Status</th><th>Resolves To</th><th>SSL</th><th>Verdict</th><th></th></tr></thead>' +
        '<tbody>' + site.domains.map(d => {
          const dotColor = d.status==="good"?"#34d399":d.status==="issue"?"#f87171":d.status==="confirmed"?"#2dd4bf":d.status==="pending"?"#fbbf24":"#4b5563";
          const resolvesTo = d.dns ? (d.dns.cnames.length > 0 ? d.dns.cnames.join(", ") : d.dns.ips.length > 0 ? d.dns.ips.join(", ") : "\\u2014") : "\\u2014";
          const statusBadge = d.status==="good"?'b-green':d.status==="issue"?'b-red':d.status==="confirmed"?'b-teal':d.status==="pending"?'b-amber':'b-gray';
          const verdictCls = d.status==="good"?"v-good":d.status==="issue"?"v-issue":d.status==="confirmed"?"v-confirmed":d.status==="pending"?"v-pending":"v-na";
          const verdictText = d.status==="good"?"GOOD":d.status==="issue"?"ISSUE":d.status==="confirmed"?"CONFIRMED":d.status==="pending"?"PENDING":d.status==="system"?"\\u2014":"?";
          const netBadge = d.network_type==="AN"?"b-blue":d.network_type==="GES"?"b-green":"b-gray";
          const sslBadge = d.sslStatus==="active"?"b-green":d.sslStatus==="expired"?"b-red":d.sslStatus==="pending_validation"?"b-amber":"b-gray";
          const confirmBtn = d.status==="issue" ? '<button class="confirm-btn mark" data-domain="' + esc(d.name) + '" data-action="confirm">Confirm OK</button>' : d.status==="confirmed" ? '<button class="confirm-btn unmark" data-domain="' + esc(d.name) + '" data-action="unconfirm">Unconfirm</button>' : '';

          return '<tr>' +
            '<td><div class="domain-name"><div class="d-dot" style="background:'+dotColor+'"></div>' +
              '<span class="'+(d.isSystem?'system-name':'')+'">' + esc(d.name) + '</span>' +
              (d.primary ? ' <span class="badge b-blue">primary</span>' : '') +
              (d.isSystem ? ' <span class="badge b-gray">system</span>' : '') +
              (d.redirect_to ? ' <span class="redirect">\\u2192 ' + esc(d.redirect_to) + '</span>' : '') +
            '</div></td>' +
            '<td><span class="badge '+netBadge+'">' + esc(d.network_type||"\\u2014") + '</span></td>' +
            '<td><span class="badge '+statusBadge+'">' + esc(d.status==="confirmed"?(d.originalDetail||d.detail):d.detail) + '</span></td>' +
            '<td><span class="resolves-to">' + esc(resolvesTo) + '</span></td>' +
            '<td><span class="badge '+sslBadge+'">' + esc(d.sslStatus||"\\u2014") + '</span></td>' +
            '<td><span class="verdict '+verdictCls+'">' + verdictText + '</span></td>' +
            '<td>' + confirmBtn + '</td>' +
          '</tr>';
        }).join("") + '</tbody>' +
      '</table>' +
    '</div>';
  }).join("");

  el.querySelectorAll(".site-header").forEach(hdr => {
    hdr.addEventListener("click", () => {
      const table = hdr.nextElementSibling;
      const chev = hdr.querySelector(".chevron");
      if (table && table.tagName === "TABLE") {
        const show = table.style.display === "none";
        table.style.display = show ? "table" : "none";
        chev.classList.toggle("open", show);
      }
    });
  });

  el.querySelectorAll(".confirm-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const domain = btn.dataset.domain;
      const action = btn.dataset.action;
      toggleConfirm(domain, action === "confirm");
    });
  });
}

async function doRefresh() {
  if (refreshing) return;
  refreshing = true;
  const btn = document.getElementById("refreshBtn");
  const label = document.getElementById("refreshLabel");
  btn.disabled = true;
  label.textContent = "Refreshing...";
  btn.querySelector("svg").style.display = "none";
  const spinnerEl = document.createElement("div");
  spinnerEl.className = "spinner";
  btn.insertBefore(spinnerEl, label);

  // Poll progress
  const pollId = setInterval(async () => {
    try {
      const s = await fetch("/api/status").then(r => r.json());
      if (s.progress) label.textContent = s.progress;
    } catch {}
  }, 1500);

  try {
    const res = await fetch("/api/refresh");
    const data = await res.json();
    if (!data || data.error) throw new Error((data && data.error) || "No data returned");
    DATA = data.sites || [];
    STATS = data.stats || null;
    renderStats();
    renderSites();
  } catch (e) {
    alert("Refresh failed: " + e.message);
  } finally {
    clearInterval(pollId);
    refreshing = false;
    btn.disabled = false;
    label.textContent = "Refresh";
    btn.querySelector(".spinner")?.remove();
    btn.querySelector("svg").style.display = "";
    document.getElementById("loadingScreen").classList.add("hidden");
  }
}

async function toggleConfirm(domain, confirm) {
  try {
    const method = confirm ? "POST" : "DELETE";
    const res = await fetch("/api/confirm", { method, headers: {"Content-Type":"application/json"}, body: JSON.stringify({domain}) });
    const result = await res.json();
    if (!result.ok) throw new Error("Failed");
    // Re-fetch data to get updated statuses
    const dataRes = await fetch("/api/data");
    const data = await dataRes.json();
    if (data.sites) { DATA = data.sites; STATS = data.stats; renderStats(); renderSites(); }
  } catch(e) { alert("Failed to update: " + e.message); }
}

// Filters
document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    renderSites();
  });
});
document.getElementById("searchInput").addEventListener("input", e => { currentSearch = e.target.value; renderSites(); });

// Initial load
(async () => {
  const res = await fetch("/api/data");
  const data = await res.json();
  if (data.sites && data.sites.length > 0) {
    DATA = data.sites;
    STATS = data.stats;
    renderStats();
    renderSites();
    document.getElementById("loadingScreen").classList.add("hidden");
  } else {
    doRefresh();
  }
})();
</script>
</body>
</html>`;

// ── Start ────────────────────────────────────────────────────

app.listen(PORT, function () {
  console.log("\n  WP Engine Domain Monitor running at http://localhost:" + PORT + "\n");
  console.log("  Press Ctrl+C to stop\n");

  // Auto-refresh on startup
  refreshData().then(function (d) {
    if (d) console.log("  Loaded " + d.stats.totalSites + " sites, " + d.stats.issues + " issues\n");
  }).catch(function (e) { console.error("  Initial load failed:", e.message); });
});
