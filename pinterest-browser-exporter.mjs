#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { existingPinIdsFor, writeExport } from "./pinterest-exporter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function findInstalledBrowser(env = process.env) {
  const candidates = [
    env.PINTEREST_BROWSER_PATH,
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export function parseBrowserArgs(argv) {
  const options = { board: null, output: null, concurrency: 4, maxScrolls: 250, metadataOnly: false, overwrite: false, skipDetails: false, executable: findInstalledBrowser() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--metadata-only") options.metadataOnly = true;
    else if (arg === "--overwrite") options.overwrite = true;
    else if (arg === "--skip-details") options.skipDetails = true;
    else if (arg === "--board") options.board = argv[++i];
    else if (arg === "--output") options.output = argv[++i];
    else if (arg === "--concurrency") options.concurrency = Number(argv[++i]);
    else if (arg === "--max-scrolls") options.maxScrolls = Number(argv[++i]);
    else if (arg === "--browser-path") options.executable = argv[++i];
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) throw new Error("--concurrency must be an integer from 1 to 16");
  if (!Number.isInteger(options.maxScrolls) || options.maxScrolls < 5) throw new Error("--max-scrolls must be at least 5");
  if (!options.help) {
    if (!options.board) throw new Error("--board <Pinterest board URL> is required");
    boardInfo(options.board);
  }
  return options;
}

function boardInfo(boardUrl) {
  const url = new URL(boardUrl); const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || /^(pin|search|ideas|settings)$/i.test(parts[0]) || !/(^|\.)pinterest\.[a-z.]+$/i.test(url.hostname)) throw new Error("--board must be a full Pinterest board URL");
  return { url, username: parts[0], boardSlug: parts[1], basePath: `/${parts[0]}/${parts[1]}/`, name: titleFromSlug(parts[1]) };
}
function titleFromSlug(value) { return value.split("-").filter(Boolean).map((part) => part[0]?.toLocaleUpperCase() + part.slice(1)).join(" "); }

export function pinFromCard(card) {
  return { id: card.id, title: "", description: "", alt_text: card.alt || null, link: null, created_at: null, media: { media_type: "image", images: { browser_grid: { url: card.image, width: card.width || 0, height: card.height || 0 } } }, browser_scrape: { pin_url: card.url, grid_image_url: card.image, card_alt_text: card.alt || null } };
}

export function fullSizePinimgUrl(value) {
  if (!value || !/i\.pinimg\.com/i.test(value)) return value;
  return value.replace(/(i\.pinimg\.com\/)(\d+x(?:\d+)?|236x|474x|564x)(\/)/i, (match, host, size, slash) => {
    const numeric = Number(size.match(/\d+/)?.[0] || 0); return `${host}${numeric >= 1200 ? size : "1200x"}${slash}`;
  });
}
export function pinimgRenditions(value) {
  if (!value || !/i\.pinimg\.com\/(?:\d+x(?:\d+)?|originals)\//i.test(value)) return [value].filter(Boolean);
  const replace = (size) => value.replace(/(i\.pinimg\.com\/)(?:\d+x(?:\d+)?|originals)(\/)/i, `$1${size}$2`);
  return [replace("originals"), replace("1200x"), replace("736x"), value].filter((item, index, all) => all.indexOf(item) === index);
}

async function discoverSections(page, info) {
  const links = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((anchor) => ({ href: anchor.href, text: (anchor.innerText || anchor.getAttribute("aria-label") || "").trim() })));
  const sections = new Map(); const baseDepth = info.basePath.split("/").filter(Boolean).length;
  for (const link of links) {
    let url; try { url = new URL(link.href); } catch { continue; }
    const parts = url.pathname.split("/").filter(Boolean);
    if (!url.pathname.startsWith(info.basePath) || parts.length !== baseDepth + 1 || parts.at(-1) === "_created") continue;
    const sectionSlug = parts.at(-1); const visible = link.text.split("\n")[0].trim().replace(/\s+\d+\s+Pins?$/i, "");
    const name = !visible || /^(see pins|open|more|view)$/i.test(visible) ? titleFromSlug(sectionSlug) : visible;
    sections.set(url.pathname, { id: sectionSlug, name, url: `${url.origin}${url.pathname}` });
  }
  return [...sections.values()];
}

async function collectPins(page, url, label, maxScrolls) {
  console.log(`\nScanning ${label}…`); await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 }); await page.waitForTimeout(1800);
  const pins = new Map(); let unchanged = 0; let previousHeight = 0;
  for (let turn = 0; turn < maxScrolls && unchanged < 7; turn++) {
    const cards = await page.locator('a[href*="/pin/"]').evaluateAll((anchors) => anchors.map((anchor) => {
      const match = anchor.href.match(/\/pin\/(\d+)/); const image = anchor.querySelector("img") || anchor.closest("div")?.querySelector("img");
      return match && image ? { id: match[1], url: anchor.href, image: image.currentSrc || image.src, alt: image.alt || anchor.getAttribute("aria-label") || "", width: image.naturalWidth, height: image.naturalHeight } : null;
    }).filter(Boolean));
    const before = pins.size; cards.forEach((card) => pins.set(card.id, card));
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    unchanged = pins.size === before && height === previousHeight ? unchanged + 1 : 0; previousHeight = height;
    process.stdout.write(`\r  ${pins.size} pins found`);
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 1.6, 1000))); await page.waitForTimeout(900);
  }
  process.stdout.write("\n"); return [...pins.values()];
}

async function enrichPin(page, card, index, total) {
  const pin = pinFromCard(card);
  try {
    process.stdout.write(`\r  Opening pin ${index + 1}/${total}`);
    await page.goto(card.url, { waitUntil: "domcontentloaded", timeout: 75_000 });
    await page.waitForTimeout(1400);
    await page.locator('img[src*="i.pinimg.com"], video').first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
    await page.locator('[data-test-id="pin-description"] button, [data-test-id="closeup-description"] button').first().click({ timeout: 1500 }).catch(() => {});
    const detail = await page.evaluate(() => {
      const firstText = (selectors) => {
        for (const selector of selectors) { const node = document.querySelector(selector); const text = node?.innerText?.trim(); if (text) return text; }
        return "";
      };
      const resources = [...document.querySelectorAll('script[data-test-id="resource-response-data"]')].map((node) => { try { return JSON.parse(node.textContent); } catch { return null; } }).filter(Boolean);
      const pinData = resources.find((item) => item.resource?.name === "PinResource")?.resource_response?.data || null;
      const firstValue = (...values) => values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
      const title = firstValue(pinData?.closeup_unified_title, pinData?.title, pinData?.grid_title, firstText(['[data-test-id="pin-title"]', '[data-test-id="closeup-title"]']));
      const description = firstValue(pinData?.closeup_unified_description, pinData?.description, pinData?.closeup_description, pinData?.closeup_user_note, pinData?.unified_user_note, pinData?.pin_additional_note, firstText(['[data-test-id="pin-description"]', '[data-test-id="closeup-description"]', '[data-test-id="description"]']));
      const source = document.querySelector('[data-test-id="source-link"] a, a[data-test-id="source-link"], [data-test-id="visit-button"] a')?.href || "";
      const describeImage = (image) => image ? ({ url: image.currentSrc || image.src, width: image.naturalWidth || image.width || 0, height: image.naturalHeight || image.height || 0, alt: image.alt || "" }) : null;
      const primaryNode = document.querySelector('[data-test-id="pin-closeup-image"] img, [data-test-id="closeup-image"] img, img[data-test-id="pin-closeup-image"], [data-test-id="visual-content-container"] img');
      const images = [...document.images].map(describeImage).filter((image) => /i\.pinimg\.com/i.test(image.url) && image.width >= 200 && image.height >= 200).sort((a, b) => (b.width * b.height) - (a.width * a.height));
      const primary = describeImage(primaryNode);
      const videos = [...document.querySelectorAll("video, video source")].map((video) => video.currentSrc || video.src).filter(Boolean);
      return { title, description, source: pinData?.link || source, createdAt: pinData?.created_at || null, resourceImages: pinData?.images || null, image: primary && /i\.pinimg\.com/i.test(primary.url) ? primary : images[0] || null, video: videos[0] || null };
    });
    pin.title = detail.title || ""; pin.description = detail.description || ""; pin.link = detail.source || null; pin.created_at = detail.createdAt;
    pin.browser_scrape.detail_page = { title_found: Boolean(detail.title), description_found: Boolean(detail.description), source_link_found: Boolean(detail.source), image_url: detail.image?.url || null, video_url: detail.video || null };
    if (detail.resourceImages) {
      for (const [name, image] of Object.entries(detail.resourceImages)) if (image?.url) pin.media.images[`resource_${name}`] = { url: image.url, width: image.width || 0, height: image.height || 0 };
    }
    if (detail.video) pin.media = { media_type: "video", video_list: { detail_page: { url: detail.video, width: 2000, height: 2000 } }, images: pin.media.images };
    if (detail.image) {
      const [original, large, fallback, loaded] = pinimgRenditions(detail.image.url);
      pin.media.images.detail_original = { url: original, width: 10000, height: 10000 };
      if (large) pin.media.images.detail_1200 = { url: large, width: 1200, height: 1200 };
      if (fallback) pin.media.images.detail_736 = { url: fallback, width: 736, height: 736 };
      if (loaded) pin.media.images.detail_loaded = { url: loaded, width: detail.image.width, height: detail.image.height, alt_text: detail.image.alt || null };
    }
  } catch (error) { pin.browser_scrape.detail_error = error.message; }
  return pin;
}

async function promptForBoard(page, boardUrl) {
  console.log("\nEdge has opened with a dedicated Pinterest export profile.");
  console.log("Log in to Pinterest if requested and make sure the board is visible.");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  await input.question("Press Enter here when the board is ready… "); input.close();
  if (!page.url().includes("pinterest.")) await page.goto(boardUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
}

export async function runBrowser(options) {
  if (!options.executable) throw new Error("Microsoft Edge or Google Chrome was not found. Install one, or pass --browser-path <file>.");
  const info = boardInfo(options.board); const profile = path.join(HERE, ".browser-profile");
  const context = await chromium.launchPersistentContext(profile, { executablePath: options.executable, headless: false, viewport: { width: 1440, height: 1000 }, args: ["--disable-blink-features=AutomationControlled"] });
  try {
    const page = context.pages()[0] || await context.newPage(); await page.goto(options.board, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await promptForBoard(page, options.board); await page.goto(options.board, { waitUntil: "domcontentloaded", timeout: 90_000 }); await page.waitForTimeout(2000);
    const pageTitle = await page.title(); let sections = await discoverSections(page, info);
    if (!sections.length) {
      console.warn("No section links were detected. If this board has sections, expand or reveal them in Edge now.");
      const input = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await input.question("Press Enter to retry section discovery, or type 'continue' to export as one group: "); input.close();
      if (!answer.trim().toLocaleLowerCase().startsWith("c")) { await page.waitForTimeout(750); sections = await discoverSections(page, info); }
    }
    console.log(`Found ${sections.length} board section${sections.length === 1 ? "" : "s"}: ${sections.map((item) => item.name).join(", ") || "none"}`);
    const rootCards = await collectPins(page, options.board, "board overview", options.maxScrolls);
    const groups = []; const assigned = new Set();
    for (const section of sections) {
      const cards = await collectPins(page, section.url, section.name, options.maxScrolls); cards.forEach((card) => assigned.add(card.id));
      groups.push({ section: { id: section.id, name: section.name }, cards });
    }
    const unsectioned = rootCards.filter((card) => !assigned.has(card.id));
    if (unsectioned.length || !groups.length) groups.push({ section: { id: null, name: groups.length ? "Unsectioned" : info.name }, cards: unsectioned.length ? unsectioned : rootCards });
    const uniqueCards = new Map(groups.flatMap((group) => group.cards).map((card) => [card.id, card]));
    const detectedBoardName = pageTitle.replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*Pinterest.*$/i, "").trim();
    const board = { id: null, name: !detectedBoardName || /^Pinterest$/i.test(detectedBoardName) ? info.name : detectedBoardName, description: "Exported from a logged-in Pinterest browser session.", owner: { username: info.username }, browser_scrape: { section_count: sections.length } };
    const existingPinIds = await existingPinIdsFor(board, options);
    const newCards = [...uniqueCards.values()].filter((card) => !existingPinIds.has(String(card.id)));
    console.log(`\nCollected ${uniqueCards.size} unique pins: ${existingPinIds.size} previously indexed, ${newCards.length} new. ${options.skipDetails ? "Skipping" : "Fetching"} detail metadata for new pins only…`);
    const enriched = new Map();
    let allPins;
    if (options.skipDetails) allPins = newCards.map(pinFromCard);
    else {
      const detailPage = await context.newPage(); const cards = newCards; allPins = [];
      for (let index = 0; index < cards.length; index++) allPins.push(await enrichPin(detailPage, cards[index], index, cards.length));
      process.stdout.write("\n"); await detailPage.close();
    }
    allPins.forEach((pin) => enriched.set(pin.id, pin));
    if (!options.skipDetails) {
      const missingDescriptions = allPins.filter((pin) => !pin.description).length;
      const missingDetailMedia = allPins.filter((pin) => !pin.browser_scrape?.detail_page?.image_url && !pin.browser_scrape?.detail_page?.video_url).length;
      if (missingDescriptions) console.warn(`  ${missingDescriptions} pin${missingDescriptions === 1 ? " has" : "s have"} no description exposed on its detail page; no inferred description will be substituted.`);
      if (missingDetailMedia) console.warn(`  ${missingDetailMedia} pin${missingDetailMedia === 1 ? " is" : "s are"} missing detail-page media and will fall back to the board rendition.`);
    }
    const exportGroups = groups.map((group) => ({ section: group.section, pins: group.cards.map((card) => enriched.get(card.id)).filter(Boolean) }));
    return await writeExport(board, exportGroups, { ...options, source: options.board, method: "browser" });
  } finally { await context.close(); }
}

function help() { return `Tokenless Pinterest board exporter\n\nUsage:\n  npm run pinterest-scrape -- --board <Pinterest board URL> [options]\n\nA visible Edge or Chrome window opens. Log in normally, then press Enter in PowerShell.\nPreviously indexed Pins are skipped automatically.\n\nRequired:\n  --board <url>          Full URL of the Pinterest board to export\n\nOptions:\n  --output <folder>      Destination; relative paths use the current directory\n  --concurrency <1-16>   Parallel media downloads (default: 4)\n  --max-scrolls <number> Safety limit per section (default: 250)\n  --skip-details         Skip Pin pages; metadata may be blank and images smaller\n  --metadata-only        Do not download media\n  --overwrite            Replace only conflicting files for newly found Pins\n  --browser-path <file>  Edge or Chrome executable\n  --help                 Show this help`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) { try { const options = parseBrowserArgs(process.argv.slice(2)); if (options.help) console.log(help()); else await runBrowser(options); } catch (error) { console.error(`\nScrape failed: ${error.message}`); process.exitCode = 1; } }
