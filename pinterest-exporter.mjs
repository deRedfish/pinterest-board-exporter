#!/usr/bin/env node
import { mkdir, writeFile, access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const API = "https://api.pinterest.com/v5";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.cwd();
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function parseArgs(argv) {
  const options = { board: null, output: null, concurrency: 4, metadataOnly: false, overwrite: false, metrics: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--metadata-only") options.metadataOnly = true;
    else if (arg === "--overwrite") options.overwrite = true;
    else if (arg === "--metrics") options.metrics = true;
    else if (arg === "--board") options.board = argv[++i];
    else if (arg === "--output") options.output = argv[++i];
    else if (arg === "--concurrency") options.concurrency = Number(argv[++i]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) throw new Error("--concurrency must be an integer from 1 to 16");
  if (!options.help) {
    if (!options.board) throw new Error("--board <Pinterest board URL> is required");
    boardReference(options.board);
  }
  return options;
}

export function boardReference(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error("--board must be a full Pinterest board URL"); }
  if (!/(^|\.)pinterest\.[a-z.]+$/i.test(url.hostname)) throw new Error("--board must use a pinterest.com domain");
  const parts = url.pathname.split("/").filter(Boolean); const [username, slug] = parts;
  if (parts.length !== 2 || !username || !slug || /^(pin|search|ideas|settings)$/i.test(username)) throw new Error("The Pinterest URL must contain exactly a username and board slug");
  return { id: null, username: username.toLocaleLowerCase(), slug: slug.toLocaleLowerCase() };
}

export function safeName(value, fallback = "Untitled") {
  let name = String(value || fallback).normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim();
  if (!name) name = fallback;
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  return name.slice(0, 110);
}

function slug(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

class PinterestApi {
  constructor(token) { this.token = token; }
  async request(endpoint, params = {}) {
    const url = new URL(`${API}${endpoint}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(url, { headers: { authorization: `Bearer ${this.token}`, accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
      if (response.ok) return response.json();
      const body = await response.text();
      if ((response.status === 429 || response.status >= 500) && attempt < 4) { await sleep(Math.min(15_000, 750 * 2 ** attempt)); continue; }
      let detail = body;
      try { const parsed = JSON.parse(body); detail = parsed.message || parsed.error?.message || body; } catch {}
      if (response.status === 401 || response.status === 403) throw new Error(`Pinterest authorization failed (${response.status}). Check that the token is current and has boards:read and pins:read scopes. ${detail}`);
      throw new Error(`Pinterest API request failed (${response.status} ${url.pathname}): ${detail}`);
    }
  }
  async pages(endpoint, params = {}) {
    const items = []; let bookmark = null;
    do {
      const page = await this.request(endpoint, { ...params, page_size: 100, bookmark });
      items.push(...(page.items || [])); bookmark = page.bookmark || null;
    } while (bookmark);
    return items;
  }
}

async function resolveBoard(api, reference) {
  if (reference.id) return api.request(`/boards/${reference.id}`);
  const boards = await api.pages("/boards");
  const matches = boards.filter((board) => {
    const owner = (board.owner?.username || board.board_owner?.username || "").toLocaleLowerCase();
    return slug(board.name) === reference.slug && (!owner || owner === reference.username);
  });
  if (matches.length === 1) return matches[0];
  const loose = boards.filter((board) => slug(board.name) === reference.slug);
  if (loose.length === 1) return loose[0];
  const available = boards.slice(0, 20).map((board) => `${board.name} (${board.id})`).join(", ");
  throw new Error(`Could not uniquely match /${reference.username}/${reference.slug}/ to an accessible board. Accessible boards: ${available || "none"}`);
}

function collectMediaCandidates(value, output = [], key = "") {
  if (!value || typeof value !== "object") return output;
  if (typeof value.url === "string" && /^https:\/\//i.test(value.url)) output.push({ url: value.url, width: Number(value.width || 0), height: Number(value.height || 0), key });
  for (const [childKey, child] of Object.entries(value)) if (child && typeof child === "object") collectMediaCandidates(child, output, childKey);
  return output;
}

export function mediaCandidates(pin) {
  const candidates = collectMediaCandidates(pin.media || {});
  if (!candidates.length) return [];
  const mediaType = String(pin.media?.media_type || "").toLocaleLowerCase();
  const video = candidates.filter((item) => /\.mp4(?:\?|$)/i.test(item.url));
  const pool = mediaType.includes("video") && video.length ? video : candidates.filter((item) => !/\.m3u8(?:\?|$)/i.test(item.url));
  return (pool.length ? pool : candidates).sort((a, b) => (b.width * b.height) - (a.width * a.height) || mediaRank(b.key) - mediaRank(a.key));
}
export function chooseMedia(pin) { return mediaCandidates(pin)[0] || null; }

function mediaRank(key) { const match = String(key).match(/(\d{3,4})/); return match ? Number(match[1]) : /original/i.test(key) ? 10_000 : 0; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function readJson(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; } }
function csv(value) { const text = value === null || value === undefined ? "" : String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function markdownText(value) { return String(value || "").replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim(); }
function markdownUrl(value) { return String(value || "").replaceAll(" ", "%20").replaceAll("(", "%28").replaceAll(")", "%29"); }

function extensionFor(url, contentType = "") {
  const types = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/quicktime": ".mov" };
  const normalized = contentType.split(";")[0].toLocaleLowerCase();
  if (types[normalized]) return types[normalized];
  try { const ext = path.extname(new URL(url).pathname).toLocaleLowerCase(); if (/^\.(jpe?g|png|webp|gif|mp4|mov)$/.test(ext)) return ext === ".jpeg" ? ".jpg" : ext; } catch {}
  return ".bin";
}

async function fetchMedia(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers: { "user-agent": "Anbennar Pinterest Board Exporter/1.0" }, redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (response.ok) return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") || "" };
    if ((response.status === 429 || response.status >= 500) && attempt < 3) { await sleep(800 * 2 ** attempt); continue; }
    throw new Error(`Media download failed (${response.status}): ${url}`);
  }
}

async function pool(items, concurrency, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; await worker(items[index], index); }
  });
  await Promise.all(workers);
}

function sectionKey(section) { return section?.id ? `id:${section.id}` : `name:${String(section?.name || "").trim().toLocaleLowerCase()}`; }

export function outputRootFor(board, options) {
  return path.resolve(WORKSPACE, options.output || path.join("Pinterest Exports", safeName(board.name || "Pinterest Board")));
}

export async function loadExistingExport(outputRoot) {
  const result = { pinIds: new Set(), sections: [] };
  let entries = [];
  try { entries = await readdir(outputRoot, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))) {
    const folder = path.join(outputRoot, entry.name); const metadataFolder = path.join(folder, ".metadata");
    let metadataFiles = [];
    try { metadataFiles = await readdir(metadataFolder); } catch {}
    const sectionDocument = await readJson(path.join(metadataFolder, "section.json"));
    const recordsById = new Map();
    for (const record of sectionDocument?.pins || []) if (record?.pin?.id) recordsById.set(String(record.pin.id), record);
    for (const filename of metadataFiles.filter((name) => name.endsWith(".json") && name !== "section.json").sort()) {
      const record = await readJson(path.join(metadataFolder, filename));
      if (record?.pin?.id && !recordsById.has(String(record.pin.id))) recordsById.set(String(record.pin.id), record);
    }
    let visibleFiles = [];
    try { visibleFiles = await readdir(folder); } catch {}
    for (const filename of [...metadataFiles, ...visibleFiles]) {
      const id = filename.match(/\[(\d+)\]/)?.[1];
      if (id) result.pinIds.add(id);
    }
    const records = [...recordsById.values()];
    for (const record of records) result.pinIds.add(String(record.pin.id));
    if (!records.length && !sectionDocument?.section) continue;
    const fallbackName = entry.name.replace(/^\d+\s*-\s*/, "");
    const first = records[0]?.export;
    const section = sectionDocument?.section || { id: first?.section_id ?? null, name: first?.section_name || fallbackName };
    result.sections.push({ folderName: entry.name, section, records });
  }
  return result;
}

export async function existingPinIdsFor(board, options) {
  return (await loadExistingExport(outputRootFor(board, options))).pinIds;
}

function manifestRow(record, folderName) {
  const pin = record.pin; const exported = record.export;
  return { section: exported.section_name || "", pin_id: pin.id, title: pin.title || "", description: pin.description || "", link: pin.link || "", source_url: exported.source_url || `https://www.pinterest.com/pin/${pin.id}/`, media_file: exported.media_file ? `${folderName}/${exported.media_file}` : "", created_at: pin.created_at || "", error: exported.download_error || "" };
}

function highestOrdinal(records) {
  return records.reduce((highest, record) => Math.max(highest, Number(record.export?.media_file?.match(/^(\d+)/)?.[1] || 0)), 0);
}

async function exportSection(section, folderName, pins, existingRecords, root, options, manifest) {
  const folder = path.join(root, folderName); const metadataFolder = path.join(folder, ".metadata");
  await mkdir(metadataFolder, { recursive: true });
  const sectionRecords = [...existingRecords]; const ordinalBase = Math.max(existingRecords.length, highestOrdinal(existingRecords));
  console.log(`\n${section.name}: ${pins.length} new pin${pins.length === 1 ? "" : "s"}`);
  await pool(pins, options.concurrency, async (pin, index) => {
    const ordinal = String(ordinalBase + index + 1).padStart(4, "0");
    const label = safeName(pin.title || pin.description?.slice(0, 70) || `Pin ${pin.id}`);
    const stem = `${ordinal} [${pin.id}]`;
    const candidates = mediaCandidates(pin); let media = candidates[0] || null; let mediaFile = null; let error = null;
    if (media && !options.metadataOnly) {
      const failures = [];
      for (const candidate of candidates) {
        try {
          const downloaded = await fetchMedia(candidate.url); const extension = extensionFor(candidate.url, downloaded.contentType);
          media = candidate; mediaFile = `${stem}${extension}`; const destination = path.join(folder, mediaFile);
          if (options.overwrite || !(await exists(destination))) await writeFile(destination, downloaded.bytes);
          error = null; break;
        } catch (cause) { failures.push(cause.message); error = cause.message; }
      }
      if (error) console.warn(`  ! ${pin.id}: ${failures.at(-1)}`);
    }
    const sourceUrl = `https://www.pinterest.com/pin/${pin.id}/`;
    const record = { export: { section_id: section.id, section_name: section.name, source_url: sourceUrl, selected_media_url: media?.url || null, media_file: mediaFile, download_error: error }, pin };
    await writeFile(path.join(metadataFolder, `${stem}.json`), JSON.stringify(record, null, 2), "utf8");
    sectionRecords[existingRecords.length + index] = record;
    if (!error) console.log(`  ✓ ${index + 1}/${pins.length} ${label}`);
  });
  await writeFile(path.join(metadataFolder, "section.json"), JSON.stringify({ section, pins: sectionRecords }, null, 2), "utf8");
  await writeFile(path.join(folder, "Pinterest Pins.md"), sectionMarkdown(sectionRecords), "utf8");
  for (const record of sectionRecords) manifest.push(manifestRow(record, folderName));
}

export function sectionMarkdown(records) {
  return records.map((record, index) => {
    const ordinal = index + 1; const filename = record.export.media_file || `${String(ordinal).padStart(4, "0")} [${record.pin.id}]`;
    const lines = [`## ${ordinal}. \`${filename}\``, "", `[Pin link](${markdownUrl(record.export.source_url)})`];
    const description = String(record.pin.description || "").replace(/\r\n/g, "\n").trim();
    if (description) lines.push("", description);
    return lines.join("\n");
  }).join("\n\n") + "\n";
}

export async function run(options) {
  const token = process.env.PINTEREST_ACCESS_TOKEN;
  if (!token) throw new Error("Set PINTEREST_ACCESS_TOKEN to a Pinterest token with boards:read and pins:read scopes, or run `npm run pinterest-scrape` for tokenless browser mode. The token is never written to disk.");
  const api = new PinterestApi(token); const reference = boardReference(options.board);
  console.log("Resolving board…");
  const board = await resolveBoard(api, reference); console.log(`Board: ${board.name} (${board.id})`);
  const pinParams = options.metrics ? { pin_metrics: true } : {};
  const [sections, boardPins] = await Promise.all([api.pages(`/boards/${board.id}/sections`), api.pages(`/boards/${board.id}/pins`, pinParams)]);
  console.log(`Found ${sections.length} section${sections.length === 1 ? "" : "s"} and ${boardPins.length} board pins.`);

  const pinsById = new Map(boardPins.map((pin) => [pin.id, pin])); const assigned = new Set(); const groups = [];
  for (const section of sections) {
    const sectionPins = await api.pages(`/boards/${board.id}/sections/${section.id}/pins`, pinParams);
    const pins = sectionPins.map((pin) => ({ ...(pinsById.get(pin.id) || {}), ...pin }));
    pins.forEach((pin) => { pinsById.set(pin.id, pin); assigned.add(pin.id); });
    groups.push({ section, pins });
  }
  for (const pin of pinsById.values()) {
    if (assigned.has(pin.id) || !pin.board_section_id) continue;
    const group = groups.find((item) => item.section.id === pin.board_section_id);
    if (group) { group.pins.push(pin); assigned.add(pin.id); }
  }
  const unsectioned = [...pinsById.values()].filter((pin) => !assigned.has(pin.id));
  if (unsectioned.length) groups.push({ section: { id: null, name: "Unsectioned", board_id: board.id }, pins: unsectioned });
  return writeExport(board, groups, { ...options, source: options.board });
}

export async function writeExport(board, groups, options) {
  const source = options.source || options.board || "Pinterest browser export";
  const outputRoot = outputRootFor(board, options);
  const rootMetadata = path.join(outputRoot, ".metadata"); await mkdir(rootMetadata, { recursive: true });
  const existing = await loadExistingExport(outputRoot); const manifest = []; const usedSections = new Set(); const seenNew = new Set();
  let nextFolderNumber = existing.sections.reduce((highest, item) => Math.max(highest, Number(item.folderName.match(/^(\d+)/)?.[1] || 0)), 0);
  let newPinCount = 0;
  for (const group of groups) {
    const key = sectionKey(group.section); const prior = existing.sections.find((item) => !usedSections.has(item) && sectionKey(item.section) === key);
    if (prior) usedSections.add(prior);
    const pins = group.pins.filter((pin) => {
      const id = String(pin.id);
      if (existing.pinIds.has(id) || seenNew.has(id)) return false;
      seenNew.add(id); return true;
    });
    newPinCount += pins.length;
    if (prior && !pins.length) {
      for (const record of prior.records) manifest.push(manifestRow(record, prior.folderName));
      continue;
    }
    if (!prior && !pins.length) continue;
    const folderName = prior?.folderName || `${String(++nextFolderNumber).padStart(3, "0")} - ${safeName(group.section.name)}`;
    await exportSection(group.section, folderName, pins, prior?.records || [], outputRoot, options, manifest);
  }
  for (const prior of existing.sections.filter((item) => !usedSections.has(item))) {
    for (const record of prior.records) manifest.push(manifestRow(record, prior.folderName));
  }
  manifest.sort((a, b) => a.section.localeCompare(b.section) || a.pin_id.localeCompare(b.pin_id));
  const sectionCount = new Set(manifest.map((row) => row.section)).size;
  const csvRows = [["section", "pin_id", "title", "description", "link", "source_url", "media_file", "created_at", "error"], ...manifest.map((row) => Object.values(row))];
  await writeFile(path.join(outputRoot, "manifest.csv"), csvRows.map((row) => row.map(csv).join(",")).join("\r\n") + "\r\n", "utf8");
  const allSections = [...groups.map((group) => group.section), ...existing.sections.filter((item) => !usedSections.has(item)).map((item) => item.section)];
  await writeFile(path.join(rootMetadata, "board.json"), JSON.stringify({ export: { source, exported_at: new Date().toISOString(), output: outputRoot, section_count: sectionCount, pin_count: manifest.length, new_pin_count: newPinCount, metadata_only: options.metadataOnly, method: options.method || "api" }, board, sections: allSections }, null, 2), "utf8");
  const boardArticle = [`# ${board.name}`, "", markdownText(board.description || "Pinterest reference board export."), "", `[Open the original Pinterest board](${markdownUrl(source)})`, "", `${manifest.length} pins organized into ${sectionCount} section folders.`, ""];
  await writeFile(path.join(outputRoot, "Board.md"), boardArticle.join("\n"), "utf8");
  console.log(`\nAdded ${newPinCount} new pin${newPinCount === 1 ? "" : "s"}; ${manifest.length} total pins in ${sectionCount} section folders.`); console.log(outputRoot);
  return { outputRoot, pinCount: manifest.length, newPinCount, sectionCount };
}

function help() {
  return `Pinterest board exporter\n\nUsage:\n  npm run pinterest-export -- --board <Pinterest board URL> [options]\n\nRequired:\n  --board <url>          Full URL of the Pinterest board to export\n\nOptions:\n  --output <folder>      Destination; relative paths use the current directory\n  --concurrency <1-16>   Parallel media downloads (default: 4)\n  --metadata-only        Export JSON and CSV without downloading media\n  --metrics              Request owner analytics where available\n  --overwrite            Replace only conflicting files for newly found Pins\n  --help                 Show this help\n\nAuthentication:\n  Set PINTEREST_ACCESS_TOKEN with boards:read and pins:read scopes.\n  Tokens are never accepted as command arguments or written to disk.`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { const options = parseArgs(process.argv.slice(2)); if (options.help) console.log(help()); else await run(options); }
  catch (error) { console.error(`\nExport failed: ${error.message}`); process.exitCode = 1; }
}
