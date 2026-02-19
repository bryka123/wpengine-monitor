#!/usr/bin/env node
/**
 * WP Engine Domain Monitor
 *
 * Fetches all installs + domains from WP Engine API,
 * uses the API's own network_info.status + DNS lookups for verification,
 * and generates a self-contained HTML dashboard.
 *
 * Usage:
 *   node generate-dashboard.js <API_USER> <API_PASS>
 *   node generate-dashboard.js  (uses env vars WPE_API_USER / WPE_API_PASS)
 */

const fetch = require("node-fetch");
const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.wpengineapi.com/v1";

// Known WP Engine CNAME suffixes
const WPE_CNAME_SUFFIXES = [".wpengine.com", ".wpenginepowered.com", ".wpesvc.net", ".wpeproxy.com"];

// Known WP Engine IP addresses (from real DNS lookups across the account)
const WPE_IP_PREFIXES = ["141.193.213.", "35.203.43.", "172.64.80."];

// ── API helpers ──────────────────────────────────────────────

function makeHeaders(user, pass) {
  return {
    Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
    "Content-Type": "application/json",
  };
}

async function apiFetch(urlPath, headers) {
  const res = await fetch(`${API_BASE}${urlPath}`, { headers });
  if (!res.ok) throw new Error(`API ${res.status} on ${urlPath}`);
  return res.json();
}

async function fetchAllInstalls(headers) {
  let all = [];
  let offset = 0;
  while (true) {
    const data = await apiFetch(`/installs?limit=100&offset=${offset}`, headers);
    all = all.concat(data.results || []);
    if (!data.next) break;
    offset += 100;
  }
  return all;
}

async function fetchDomains(installId, headers) {
  try {
    const data = await apiFetch(`/installs/${installId}/domains?limit=100`, headers);
    return data.results || [];
  } catch {
    return [];
  }
}

// ── DNS helpers ──────────────────────────────────────────────

async function dnsLookup(domain) {
  const result = { ips: [], cnames: [], resolved: false };
  try {
    result.ips = await dns.resolve4(domain);
    result.resolved = true;
  } catch {}
  try {
    result.cnames = await dns.resolveCname(domain);
    result.resolved = result.resolved || result.cnames.length > 0;
  } catch {}
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

// ── Batch helper ─────────────────────────────────────────────

async function batchAsync(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

// ── Determine domain status ──────────────────────────────────

function determineDomainStatus(domain, dnsResult, installCname, allDomainNames) {
  const isSystem = domain.name.endsWith(".wpenginepowered.com") || domain.name.endsWith(".wpengine.com");
  if (isSystem) return { status: "system", detail: "System domain" };

  // Primary source of truth: WP Engine API's network_info
  const networkStatus = domain.network_details?.network_info?.status?.toUpperCase();
  const sslStatus = domain.network_details?.network_info?.ssl?.status?.toLowerCase();

  // Expected IPs/CNAME from WPE API
  const expectedCname = domain.network_details?.dns_config_info?.cname || null;
  const expectedARecords = domain.network_details?.dns_config_info?.a_records || [];

  const dnsMatches = dnsResult ? dnsPointsToWPE(dnsResult, installCname, allDomainNames) : false;

  // Also check if DNS IPs match the WPE-provided expected A records
  let dnsMatchesExpected = false;
  if (dnsResult && dnsResult.ips.length > 0 && expectedARecords.length > 0) {
    dnsMatchesExpected = dnsResult.ips.some((ip) => expectedARecords.includes(ip));
  }
  // Check if CNAME matches the expected CNAME
  let cnameMatchesExpected = false;
  if (dnsResult && dnsResult.cnames.length > 0 && expectedCname) {
    cnameMatchesExpected = dnsResult.cnames.some((c) => c === expectedCname);
  }

  if (networkStatus === "ACTIVE") {
    // WPE says it's active
    if (dnsMatches || dnsMatchesExpected || cnameMatchesExpected) {
      return { status: "good", detail: "Active & DNS pointed" };
    }
    if (dnsResult && dnsResult.resolved) {
      // DNS resolves but not to WPE — it's pointed elsewhere
      return { status: "issue", detail: "DNS not pointed to WPE" };
    }
    if (dnsResult && !dnsResult.resolved) {
      return { status: "issue", detail: "DNS not resolving" };
    }
    // No DNS check yet — trust the API
    return { status: "good", detail: "Active (API)" };
  }

  if (networkStatus === "PENDING") {
    return { status: "pending", detail: "Pending setup" };
  }

  if (networkStatus === "DELETED") {
    return { status: "issue", detail: "Network deleted" };
  }

  // LEGACY domains or no network_info — rely on DNS
  if (!networkStatus) {
    if (dnsMatches) return { status: "good", detail: "DNS pointed (Legacy)" };
    if (dnsResult && dnsResult.resolved) return { status: "issue", detail: "DNS not pointed to WPE" };
    if (dnsResult && !dnsResult.resolved) return { status: "issue", detail: "DNS not resolving" };
    return { status: "unknown", detail: "No status data" };
  }

  return { status: "unknown", detail: networkStatus || "Unknown" };
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const user = process.argv[2] || process.env.WPE_API_USER;
  const pass = process.argv[3] || process.env.WPE_API_PASS;
  if (!user || !pass) {
    console.error("Usage: node generate-dashboard.js <API_USER> <API_PASS>");
    process.exit(1);
  }

  const headers = makeHeaders(user, pass);

  console.log("→ Fetching installs...");
  const installs = await fetchAllInstalls(headers);
  console.log(`  Found ${installs.length} installs`);

  console.log("→ Fetching domains for each install...");
  const installDomains = await batchAsync(installs, 10, async (inst) => {
    const domains = await fetchDomains(inst.id, headers);
    return { install: inst, domains };
  });

  // Build set of all domain names (for cross-domain CNAME detection)
  const allDomainNames = new Set();
  for (const { domains } of installDomains) {
    for (const d of domains) allDomainNames.add(d.name);
  }

  // Flatten custom domains for DNS lookup
  const allCustomDomains = [];
  for (const { install, domains } of installDomains) {
    for (const d of domains) {
      const isSystem = d.name.endsWith(".wpenginepowered.com") || d.name.endsWith(".wpengine.com");
      if (!isSystem) allCustomDomains.push({ ...d, _installCname: install.cname });
    }
  }

  console.log(`→ Running DNS checks on ${allCustomDomains.length} custom domains...`);
  const dnsResults = {};
  let done = 0;
  await batchAsync(allCustomDomains, 30, async (d) => {
    const result = await dnsLookup(d.name);
    dnsResults[d.id] = result;
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${allCustomDomains.length}`);
    return result;
  });
  console.log(`  ${allCustomDomains.length}/${allCustomDomains.length} done`);

  // Build final data structure
  const siteData = installDomains.map(({ install, domains }) => {
    const enrichedDomains = domains.map((d) => {
      const isSystem = d.name.endsWith(".wpenginepowered.com") || d.name.endsWith(".wpengine.com");
      const dnsResult = dnsResults[d.id] || null;
      const { status, detail } = determineDomainStatus(d, dnsResult, install.cname, allDomainNames);
      const sslStatus = d.network_details?.network_info?.ssl?.status || null;

      return {
        name: d.name,
        id: d.id,
        primary: d.primary,
        network_type: d.network_type || "",
        redirect_to: d.redirect_to?.name || null,
        isSystem,
        dns: dnsResult,
        status,       // "good" | "issue" | "pending" | "system" | "unknown"
        detail,       // human-readable explanation
        sslStatus,
        expectedCname: d.network_details?.dns_config_info?.cname || null,
        expectedARecords: d.network_details?.dns_config_info?.a_records || [],
      };
    });

    const customDomains = enrichedDomains.filter((d) => !d.isSystem);
    const issueCount = customDomains.filter((d) => d.status === "issue").length;
    const pendingCount = customDomains.filter((d) => d.status === "pending").length;

    return {
      name: install.name,
      id: install.id,
      environment: install.environment,
      primary_domain: install.primary_domain,
      cname: install.cname,
      php_version: install.php_version,
      domains: enrichedDomains,
      issueCount,
      pendingCount,
    };
  });

  // Stats
  const allDomains = siteData.flatMap((s) => s.domains);
  const customDomains = allDomains.filter((d) => !d.isSystem);
  const stats = {
    totalSites: installs.length,
    totalDomains: allDomains.length,
    customDomains: customDomains.length,
    good: customDomains.filter((d) => d.status === "good").length,
    issues: customDomains.filter((d) => d.status === "issue").length,
    pending: customDomains.filter((d) => d.status === "pending").length,
    timestamp: new Date().toISOString(),
  };

  console.log(`\n✓ Stats: ${stats.totalSites} sites | ${stats.customDomains} custom domains | ${stats.good} good | ${stats.issues} issues | ${stats.pending} pending`);

  console.log("→ Generating dashboard...");
  const html = generateHTML(siteData, stats);
  const outPath = path.join(__dirname, "dashboard.html");
  fs.writeFileSync(outPath, html, "utf-8");
  console.log(`✓ Dashboard saved to ${outPath}`);
}

// ── HTML Generator ───────────────────────────────────────────

function generateHTML(siteData, stats) {
  const dataJSON = JSON.stringify(siteData);

  return `<!DOCTYPE html>
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

  .content { max-width: 1280px; margin: 0 auto; padding: 20px 24px; }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 16px; }
  .stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #6b7280; margin-bottom: 4px; }
  .stat-value { font-size: 28px; font-weight: 700; }
  .c-white { color: #e5e7eb; } .c-blue { color: #60a5fa; } .c-indigo { color: #818cf8; }
  .c-green { color: #34d399; } .c-red { color: #f87171; } .c-amber { color: #fbbf24; }

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
  .detail-text { color: #9ca3af; font-size: 11px; }
  .verdict { font-weight: 700; font-size: 13px; }
  .v-good { color: #34d399; } .v-issue { color: #f87171; } .v-pending { color: #fbbf24; } .v-na { color: #4b5563; }

  .count-info { font-size: 11px; color: #6b7280; margin-bottom: 12px; }
  .no-match { text-align: center; padding: 48px; color: #4b5563; }
  .hidden { display: none !important; }
</style>
</head>
<body>

<div class="header">
  <div class="header-inner">
    <div class="header-left">
      <div class="logo">W</div>
      <div>
        <h1>WP Engine Domain Monitor</h1>
        <div class="meta">Generated ${stats.timestamp.replace("T", " ").slice(0, 19)} UTC</div>
      </div>
    </div>
    <div class="controls">
      <input class="search" type="text" placeholder="Search sites or domains..." id="searchInput">
      <div class="filter-group">
        <button class="filter-btn active" data-filter="all">All</button>
        <button class="filter-btn" data-filter="issues">Issues</button>
        <button class="filter-btn" data-filter="good">Good</button>
      </div>
    </div>
  </div>
</div>

<div class="content">
  <div class="stats">
    <div class="stat"><div class="stat-label">Sites</div><div class="stat-value c-white">${stats.totalSites}</div></div>
    <div class="stat"><div class="stat-label">Total Domains</div><div class="stat-value c-blue">${stats.totalDomains}</div></div>
    <div class="stat"><div class="stat-label">Custom Domains</div><div class="stat-value c-indigo">${stats.customDomains}</div></div>
    <div class="stat"><div class="stat-label">Good</div><div class="stat-value c-green">${stats.good}</div></div>
    <div class="stat"><div class="stat-label">Issues</div><div class="stat-value ${stats.issues > 0 ? "c-red" : "c-green"}">${stats.issues}</div></div>
    <div class="stat"><div class="stat-label">Pending</div><div class="stat-value c-amber">${stats.pending}</div></div>
  </div>
  <div class="count-info" id="countInfo"></div>
  <div id="siteList"></div>
  <div class="no-match hidden" id="noMatch">No sites match your filters.</div>
</div>

<script>
const DATA = ${dataJSON};
let currentFilter = "all", currentSearch = "";

function esc(s) { return s ? s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") : ""; }

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
    return site.issueCount === 0;
  });

  document.getElementById("countInfo").textContent = "Showing " + filtered.length + " of " + DATA.length + " sites";
  document.getElementById("noMatch").classList.toggle("hidden", filtered.length > 0);

  el.innerHTML = filtered.map(site => {
    const dotCls = site.issueCount > 0 ? "dot-red" : site.domains.filter(d=>!d.isSystem&&d.status==="good").length === site.domains.filter(d=>!d.isSystem).length && site.domains.filter(d=>!d.isSystem).length > 0 ? "dot-green" : "dot-gray";
    const autoOpen = currentFilter === "issues" && site.issueCount > 0;

    return '<div class="site-card' + (autoOpen ? ' open' : '') + '">' +
      '<div class="site-header">' +
        '<div class="site-left">' +
          '<div class="dot ' + dotCls + '"></div>' +
          '<span class="site-name">' + esc(site.name) + '</span>' +
          '<span class="badge b-gray">' + esc(site.environment) + '</span>' +
          (site.primary_domain ? '<span class="primary-domain">' + esc(site.primary_domain) + '</span>' : '') +
          '<span class="badge b-gray">' + site.domains.length + ' domains</span>' +
          (site.issueCount > 0 ? '<span class="badge b-red">' + site.issueCount + ' issue' + (site.issueCount!==1?'s':'') + '</span>' : '') +
          (site.pendingCount > 0 ? '<span class="badge b-amber">' + site.pendingCount + ' pending</span>' : '') +
          (site.issueCount === 0 && site.pendingCount === 0 && site.domains.filter(d=>!d.isSystem).length > 0 ? '<span class="badge b-green">All good</span>' : '') +
        '</div>' +
        '<svg class="chevron' + (autoOpen ? ' open' : '') + '" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>' +
      '</div>' +
      '<table class="domain-table" style="display:' + (autoOpen ? 'table' : 'none') + '">' +
        '<thead><tr><th>Domain</th><th>Network</th><th>DNS</th><th>Resolves To</th><th>SSL</th><th>Status</th><th>Verdict</th></tr></thead>' +
        '<tbody>' + site.domains.map(d => {
          const dotColor = d.status==="good"?"#34d399":d.status==="issue"?"#f87171":d.status==="pending"?"#fbbf24":"#4b5563";
          const resolvesTo = d.dns ? (d.dns.cnames.length > 0 ? d.dns.cnames.join(", ") : d.dns.ips.length > 0 ? d.dns.ips.join(", ") : "—") : "—";

          const statusBadge = d.status==="good"?'b-green':d.status==="issue"?'b-red':d.status==="pending"?'b-amber':'b-gray';
          const verdictCls = d.status==="good"?"v-good":d.status==="issue"?"v-issue":d.status==="pending"?"v-pending":"v-na";
          const verdictText = d.status==="good"?"GOOD":d.status==="issue"?"ISSUE":d.status==="pending"?"PENDING":d.status==="system"?"—":"?";

          const netBadge = d.network_type==="AN"?"b-blue":d.network_type==="GES"?"b-green":"b-gray";
          const sslBadge = d.sslStatus==="active"?"b-green":d.sslStatus==="expired"?"b-red":d.sslStatus==="pending_validation"?"b-amber":"b-gray";

          return '<tr>' +
            '<td><div class="domain-name"><div class="d-dot" style="background:'+dotColor+'"></div>' +
              '<span class="'+(d.isSystem?'system-name':'')+'">' + esc(d.name) + '</span>' +
              (d.primary ? ' <span class="badge b-blue">primary</span>' : '') +
              (d.isSystem ? ' <span class="badge b-gray">system</span>' : '') +
              (d.redirect_to ? ' <span class="redirect">→ ' + esc(d.redirect_to) + '</span>' : '') +
            '</div></td>' +
            '<td><span class="badge '+netBadge+'">' + esc(d.network_type||"—") + '</span></td>' +
            '<td><span class="badge '+statusBadge+'">' + esc(d.detail) + '</span></td>' +
            '<td><span class="resolves-to">' + esc(resolvesTo) + '</span></td>' +
            '<td><span class="badge '+sslBadge+'">' + esc(d.sslStatus||"—") + '</span></td>' +
            '<td><span class="detail-text">' + esc(d.detail) + '</span></td>' +
            '<td><span class="verdict '+verdictCls+'">' + verdictText + '</span></td>' +
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
}

document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    renderSites();
  });
});
document.getElementById("searchInput").addEventListener("input", e => { currentSearch = e.target.value; renderSites(); });
renderSites();
</script>
</body>
</html>`;
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
