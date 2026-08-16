#!/usr/bin/env node
// test-securite.js — Tests de sécurité côté projet (aucune dépendance).
// Vérifie:
//  - safeHttpUrl rejette javascript:/data:/file:/vbscript: et chaînes invalides, accepte https/http
//  - esc() neutralise & < > " '
//  - les URLs réellement présentes dans data.json sont toutes HTTP(S)
//  - aucun résidu HTML dans les titres/résumés publiés
// Usage: node test-securite.js
const fs = require("fs");
const path = require("path");

let failures = 0;
function ok(cond, label) {
  if (cond) { console.log("  ✔ " + label); }
  else { failures++; console.error("  ✘ " + label); }
}

// --- extraction de safeHttpUrl depuis collector.js (défense à l'ingestion) ---
function collectSourceSafeHttpUrl() {
  const src = fs.readFileSync(path.join(__dirname, "collector.js"), "utf8");
  const m = src.match(/function safeHttpUrl[\s\S]*?\n}/);
  if (!m) throw new Error("safeHttpUrl introuvable dans collector.js");
  return new Function("return (" + m[0] + ")")();
}
// Extraction robuste d'une fonction JS (comptage d'accolades) depuis un source.
function extractFn(source, name) {
  const i = source.indexOf("function " + name);
  if (i < 0) return null;
  let depth = 0, j = i + ("function " + name).length;
  for (; j < source.length; j++) {
    const c = source[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return new Function("return (" + source.slice(i, j) + ")")();
}
function extractFromHtml() {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  return { esc: extractFn(html, "esc"), safeUrl: extractFn(html, "safeHttpUrl") };
}

console.log("=== 1. safeHttpUrl (collector.js, ingestion) ===");
const cSafe = collectSourceSafeHttpUrl();
ok(cSafe("https://example.org/article") === "https://example.org/article", "https accepté");
ok(cSafe("http://example.org/a") === "http://example.org/a", "http accepté");
ok(cSafe("javascript:alert(1)") === "", "javascript: rejeté");
ok(cSafe("data:text/html,<script>alert(1)</script>") === "", "data: rejeté");
ok(cSafe("file:///etc/passwd") === "", "file: rejeté");
ok(cSafe("vbscript:msgbox(1)") === "", "vbscript: rejeté");
ok(cSafe("not a url") === "", "chaîne invalide rejetée");
ok(cSafe("") === "", "vide rejeté");
ok(cSafe("   ") === "", "espaces seuls rejetés");

console.log("=== 2. safeHttpUrl + esc (index.html, rendu) ===");
const fr = extractFromHtml();
ok(!!fr.safeUrl, "safeHttpUrl présente dans index.html");
ok(!!fr.esc, "esc présente dans index.html");
if (fr.safeUrl) {
  ok(fr.safeUrl("https://x.org/a") === "https://x.org/a", "https accepté (front)");
  ok(fr.safeUrl("javascript:alert(1)") === null, "javascript: → null (non cliquable)");
  ok(fr.safeUrl("data:text/html,x") === null, "data: → null");
  ok(fr.safeUrl("") === null, "vide → null");
}
if (fr.esc) {
  ok(fr.esc("<script>") === "&lt;script&gt;", "esc neutralise < >");
  ok(fr.esc('a"b\'c&d') === "a&quot;b&#39;c&amp;d", "esc neutralise \" ' &");
  ok(fr.esc(null) === "", "esc(null) → \"\"");
}

console.log("=== 3. intègre — URLs de data.json ===");
if (fs.existsSync(path.join(__dirname, "data.json"))) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "data.json"), "utf8"));
  let n = 0, bad = 0, badHtml = 0;
  for (const g of data.groups) for (const it of g.items) {
    n++;
    if (!/^https?:\/\//.test(it.url || "")) { bad++; }
    if (/<|&[a-z]+;/.test(it.title + (it.summary || ""))) badHtml++;
  }
  ok(bad === 0, `${n} URLs toutes HTTP(S) (0 à rejeter)`);
  ok(badHtml === 0, `aucun résidu HTML dans titres/résumés (${n} articles)`);
} else {
  console.log("  (pas de data.json local — étape données sautée)");
}

console.log(failures === 0 ? "\nRÉSULTAT: OK — tous les tests passent." : `\nRÉSULTAT: ${failures} échec(s).`);
process.exit(failures === 0 ? 0 : 1);
