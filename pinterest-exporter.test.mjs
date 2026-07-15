import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { boardReference, chooseMedia, loadExistingExport, mediaCandidates, parseArgs, safeName, sectionMarkdown, writeExport } from "./pinterest-exporter.mjs";
import { parseBrowserArgs, pinFromCard, pinimgRenditions } from "./pinterest-browser-exporter.mjs";

test("parses the supplied localized Pinterest board URL", () => {
  assert.deepEqual(boardReference("https://uk.pinterest.com/ruivofa/dwarovar-campaign/"), { id: null, username: "ruivofa", slug: "dwarovar-campaign" });
});

test("requires an explicit board URL", () => {
  assert.throws(() => parseArgs([]), /--board.*required/);
  assert.throws(() => parseBrowserArgs([]), /--board.*required/);
  assert.throws(() => boardReference("123456789"), /full Pinterest board URL/);
  assert.throws(() => parseBrowserArgs(["--board", "https://www.pinterest.com/pin/123/"]), /full Pinterest board URL/);
});

test("sanitizes section and pin names for Windows", () => {
  assert.equal(safeName('CON'), "_CON");
  assert.equal(safeName('Hold: Maps / Level 1?'), "Hold- Maps - Level 1-");
});

test("selects the largest API image rendition", () => {
  const selected = chooseMedia({ media: { media_type: "image", images: { "150x150": { width: 150, height: 150, url: "https://i.pinimg.com/150x150/a.jpg" }, "1200x": { width: 900, height: 1200, url: "https://i.pinimg.com/1200x/a.jpg" } } } });
  assert.equal(selected.url, "https://i.pinimg.com/1200x/a.jpg");
});

test("prefers MP4 media for video pins", () => {
  const selected = chooseMedia({ media: { media_type: "video", cover: { width: 1200, height: 1800, url: "https://i.pinimg.com/cover.jpg" }, video_list: { V_EXP7: { width: 720, height: 1280, url: "https://v.pinimg.com/clip.mp4" } } } });
  assert.equal(selected.url, "https://v.pinimg.com/clip.mp4");
});

test("validates concurrency", () => {
  const board = ["--board", "https://www.pinterest.com/user/board/"];
  assert.throws(() => parseArgs([...board, "--concurrency", "0"]), /1 to 16/);
  assert.equal(parseArgs([...board, "--metadata-only", "--concurrency", "8"]).concurrency, 8);
});

test("builds browser-scraped pin metadata from a board card", () => {
  const pin = pinFromCard({ id: "987", url: "https://www.pinterest.com/pin/987/", image: "https://i.pinimg.com/736x/example.jpg", alt: "Dwarven city", width: 736, height: 1104 });
  assert.equal(pin.id, "987"); assert.equal(pin.title, ""); assert.equal(pin.description, ""); assert.equal(pin.alt_text, "Dwarven city"); assert.equal(pin.media.images.browser_grid.url, "https://i.pinimg.com/736x/example.jpg");
});

test("parses tokenless browser options", () => {
  const options = parseBrowserArgs(["--board", "https://www.pinterest.com/user/board/", "--skip-details", "--max-scrolls", "50"]);
  assert.equal(options.skipDetails, true); assert.equal(options.maxScrolls, 50);
});

test("generates descending full-size Pinterest fallbacks", () => {
  assert.deepEqual(pinimgRenditions("https://i.pinimg.com/236x/aa/bb/image.jpg"), ["https://i.pinimg.com/originals/aa/bb/image.jpg", "https://i.pinimg.com/1200x/aa/bb/image.jpg", "https://i.pinimg.com/736x/aa/bb/image.jpg", "https://i.pinimg.com/236x/aa/bb/image.jpg"]);
});

test("orders original media before fallback renditions", () => {
  const pin = { media: { media_type: "image", images: { original: { url: "https://i.pinimg.com/originals/a.jpg", width: 10000, height: 10000 }, fallback: { url: "https://i.pinimg.com/736x/a.jpg", width: 736, height: 736 } } } };
  assert.equal(mediaCandidates(pin)[0].url, "https://i.pinimg.com/originals/a.jpg");
});

test("section Markdown contains only ordinal, filename, Pin link, and description", () => {
  const markdown = sectionMarkdown([{ export: { media_file: "0001 [123].jpg", source_url: "https://www.pinterest.com/pin/123/" }, pin: { id: "123", title: "Excluded title", description: "Actual Pin description.", created_at: "2026-01-01" } }]);
  assert.equal(markdown, "## 1. `0001 [123].jpg`\n\n[Pin link](https://www.pinterest.com/pin/123/)\n\nActual Pin description.\n");
  assert.doesNotMatch(markdown, /Excluded title|2026-01-01|Pin ID|exported/);
});

test("incremental export indexes old pins and appends only new pins", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pinterest-incremental-"));
  const folder = path.join(root, "001 - Creatures"); const metadata = path.join(folder, ".metadata");
  await mkdir(metadata, { recursive: true });
  const oldRecord = { export: { section_id: "creatures", section_name: "Creatures", source_url: "https://www.pinterest.com/pin/111/", media_file: "0001 [111].jpg", download_error: null }, pin: { id: "111", title: "", description: "Old description." } };
  const oldJson = JSON.stringify(oldRecord, null, 2);
  await writeFile(path.join(folder, "0001 [111].jpg"), "old-image");
  await writeFile(path.join(metadata, "0001 [111].json"), oldJson);
  await writeFile(path.join(metadata, "section.json"), JSON.stringify({ section: { id: "creatures", name: "Creatures" }, pins: [oldRecord] }));

  const indexed = await loadExistingExport(root);
  assert.deepEqual([...indexed.pinIds], ["111"]);
  const newPin = { id: "222", title: "", description: "New description.", media: { media_type: "image", images: {} } };
  const result = await writeExport({ name: "Test Board", description: "" }, [{ section: { id: "creatures", name: "Creatures" }, pins: [{ id: "111" }, newPin] }], { output: root, metadataOnly: true, overwrite: true, concurrency: 1, source: "https://www.pinterest.com/test/" });

  assert.equal(result.newPinCount, 1);
  assert.equal(result.pinCount, 2);
  assert.equal(await readFile(path.join(folder, "0001 [111].jpg"), "utf8"), "old-image");
  assert.equal(await readFile(path.join(metadata, "0001 [111].json"), "utf8"), oldJson);
  const markdown = await readFile(path.join(folder, "Pinterest Pins.md"), "utf8");
  assert.match(markdown, /0001 \[111\]\.jpg/);
  assert.match(markdown, /0002 \[222\]/);
});
