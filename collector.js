#!/usr/bin/env node
// collector.js — Récupère les flux RSS, normalise, écrit data.json (site statique GitHub Pages)
// Usage: node collector.js  (lit sources.json, écrit data.json dans le dossier courant)
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const ROOT = __dirname;
const SOURCES = JSON.parse(fs.readFileSync(path.join(ROOT, "sources.json"), "utf8"));
const OUT = path.join(ROOT, "data.json");
const UA = "Mozilla/5.0 (compatible; RanpiNewsCollector/1.0; +https://news.ranpi.fr)";

// ---------- Fetch avec timeout + taille max ----------
function fetchUrl(url, maxBytes = 2 * 1024 * 1024, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*" },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, url).href, maxBytes, timeoutMs));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve({ error: "HTTP " + res.statusCode }); }
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > maxBytes) { req.destroy(); return resolve({ error: "Trop gros" }); } chunks.push(c); });
      res.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (e) => resolve({ error: e.message }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ error: "Timeout" }); });
    req.on("error", (e) => resolve({ error: e.message }));
  });
}

// ---------- Parsing XML minimal ----------
function decodeEntities(s) {
  if (!s) return "";
  const map = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'" };
  return s.replace(/&(#?[a-zA-Z0-9]+);/g, (m, e) => {
    if (e[0] === "#") { const c = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isNaN(c) ? m : String.fromCodePoint(c); }
    return map[e.toLowerCase()] ?? m;
  });
}
function stripTags(s) { return (s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
function cdata(s) { return (s || "").replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1"); }

function extractItemFields(raw, feedId) {
  const title = decodeEntities(stripTags(cdata((raw.match(/<title(?:\s[^>]*)?>(.*?)<\/title>/s) || [])[1] || "")));
  let link = cdata((raw.match(/<link(?:\s[^>]*)?>(.*?)<\/link>/s) || [])[1] || "");
  link = decodeEntities(link.replace(/<[^>]*>/g, "").trim());
  const linkAttr = ((raw.match(/<link[^>]*href="([^"]+)"/) || [])[1] || "").trim();
  if (!link) link = linkAttr;
  const desc = decodeEntities(stripTags(cdata((raw.match(/<description(?:\s[^>]*)?>(.*?)<\/description>/s) || [])[1] || "")));
  const content = decodeEntities(stripTags(cdata((raw.match(/<content:encoded(?:\s[^>]*)?>(.*?)<\/content:encoded>/s) || [])[1] || "")));
  const pubRaw = (raw.match(/<pubDate[^>]*>(.*?)<\/pubDate>/s) || raw.match(/<dc:date[^>]*>(.*?)<\/dc:date>/s) || [])[1] || "";
  const pubDate = pubRaw ? Date.parse(pubRaw.trim()) : null;
  return {
    title: title || "(sans titre)",
    url: link || linkAttr || "",
    summary: (content || desc).slice(0, 400),
    description: desc.slice(0, 600),
    published: pubDate ? new Date(pubDate).toISOString() : null,
    feed: feedId
  };
}

function parseFeed(xml, feedId) {
  if (!xml || !xml.includes("<")) return [];
  let items = [...xml.matchAll(/<item[\s>](.*?)<\/item>/gs)].map(m => m[1]);
  if (!items.length) items = [...xml.matchAll(/<entry[\s>](.*?)<\/entry>/gs)].map(m => m[1]);
  return items.map(r => extractItemFields(r, feedId)).filter(it => it.url);
}

// ---------- Nettoyage ASNR (news réelles uniquement) ----------
function normalizeKey(u) { try { const x = new URL(u); return (x.hostname + x.pathname).replace(/\/$/, "").toLowerCase(); } catch { return u; } }
function isRealAsnrArticle(t, u) {
  const u2 = (u || "").toLowerCase();
  if (/avis.?d.?expertise/.test(t) && /^\d{4}$/.test((t.match(/\d{4}/) || [""])[0] || "")) return false;
  if (/avis.?d.?expertise.*(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)/.test(t)) return false;
  if (u2.includes("/actualites/")) return true;
  if (u2.includes("/agenda/")) return false;
  return true;
}

async function collectGroup(groupName, feedDefs) {
  const results = [];
  for (const f of feedDefs) {
    try {
      const r = await fetchUrl(f.url);
      if (r.error) { results.push({ feed: f.id, source: f.name, ok: false, error: r.error, count: 0 }); continue; }
      let items = parseFeed(r.body, f.id);
      if (f.id === "asnr") items = items.filter(it => isRealAsnrArticle(it.title, it.url));
      const seen = new Set();
      items = items.filter(it => { const k = normalizeKey(it.url); if (seen.has(k) || !k) return false; seen.add(k); return true; });
      results.push({ feed: f.id, source: f.name, ok: true, count: items.length, items });
    } catch (e) {
      results.push({ feed: f.id, source: f.name, ok: false, error: e.message, count: 0 });
    }
  }
  return results;
}

async function main() {
  const groups = [];
  let totalFeeds = 0, totalOk = 0, totalItems = 0;
  for (const [gname, gcfg] of Object.entries(SOURCES.groups)) {
    const res = await collectGroup(gname, gcfg.feeds);
    const all = [];
    for (const r of res) if (r.ok && r.items) for (const it of r.items) { it.group = gname; it.source = r.source; it.sourceId = r.feed; it.lang = (gcfg.feeds.find(f => f.id === r.feed) || {}).lang || ""; all.push(it); }
    all.sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
    groups.push({ group: gname, label: gcfg.label, description: gcfg.description, color: gcfg.color, generated: new Date().toISOString(), feedResults: res, items: all });
    totalFeeds += res.length; totalOk += res.filter(r => r.ok).length; totalItems += all.length;
    for (const r of res) console.log(`[${gname}] ${r.ok ? "OK  " : "FAIL"} ${r.source}: ${r.count}${r.error ? " (" + r.error + ")" : ""}`);
  }
  const data = { generated: new Date().toISOString(), groups };
  fs.writeFileSync(OUT, JSON.stringify(data));
  console.log(`--- TOTAL: ${totalFeeds} flux, ${totalOk} OK, ${totalItems} articles -> data.json ${(fs.statSync(OUT).size / 1024).toFixed(0)} Ko ---`);
}

main().catch(e => { console.error("ERREUR FATALE:", e); process.exit(1); });
