# Pinterest Board Exporter

Export any Pinterest board you can access into clean, section-based folders. The browser mode uses your normal Pinterest login, downloads full-size media where available, and records each Pin's real description rather than guessing from the image.

Designed for Windows and PowerShell. No Pinterest developer token is required for the recommended browser workflow.

## What you get

```text
Pinterest Exports/My Board/
├── Board.md
├── manifest.csv
├── 001 - First Section/
│   ├── Pinterest Pins.md
│   ├── 0001 [123456789].jpg
│   ├── 0002 [987654321].png
│   └── .metadata/
├── 002 - Another Section/
└── 003 - Unsectioned/
```

Each board section becomes a separate folder. Pins without a section go into `Unsectioned`. Every section's `Pinterest Pins.md` contains only the pin number, downloaded filename, Pinterest link, and actual Pin description. Machine-readable metadata is kept in hidden `.metadata` folders, and `manifest.csv` provides a board-wide index.

Reruns are incremental: previously indexed Pin IDs are skipped without reopening their detail pages or overwriting their media and per-pin JSON. Newly added Pins are appended to the appropriate section.

## Requirements

- Windows 10 or 11
- [Node.js 20 or newer](https://nodejs.org/)
- Microsoft Edge or Google Chrome
- A Pinterest account that can view the board

The exporter automatically finds common Edge and Chrome installations. A custom browser can be selected with `--browser-path`.

## Install

```powershell
git clone https://github.com/your-username/pinterest-board-exporter.git
cd pinterest-board-exporter
npm install
```

Replace the clone URL with this repository's actual GitHub URL after publishing it.

## Export a board

A full board URL is required every time. Pin URLs and individual section URLs are not accepted.

```powershell
npm run pinterest-scrape -- --board "https://www.pinterest.com/user/board-name/"
```

Edge or Chrome opens with a dedicated exporter profile. Log in if Pinterest asks, make sure the board is visible, then return to PowerShell and press Enter. The login profile is retained locally in `.browser-profile` and is excluded from Git.

By default, files are written to `Pinterest Exports/<Board Name>` inside the cloned repository. To choose another location:

```powershell
npm run pinterest-scrape -- --board "https://www.pinterest.com/user/board-name/" --output "C:\Users\me\Pictures\Pinterest Export"
```

Run the same command and output path later to fetch only Pins added since the previous export:

```powershell
npm run pinterest-scrape -- --board "https://www.pinterest.com/user/board-name/" --output "C:\Users\me\Pictures\Pinterest Export"
```

## Browser options

```text
--board <url>          Full Pinterest board URL (required)
--output <folder>      Destination folder; relative paths use the current directory
--concurrency <1-16>   Parallel media downloads (default: 4)
--max-scrolls <n>      Section scrolling safety limit (default: 250)
--metadata-only        Collect metadata without downloading media
--skip-details         Faster, but descriptions may be blank and images smaller
--browser-path <file>  Explicit Edge or Chrome executable
--help                 Show command help
```

For example:

```powershell
npm run pinterest-scrape -- --board "https://www.pinterest.com/user/board-name/" --concurrency 8
```

## Section Markdown format

```markdown
## 1. `0001 [123456789].jpg`

[Pin link](https://www.pinterest.com/pin/123456789/)

The description stored on the Pin.
```

If Pinterest provides no description, the entry contains only the number, filename, and link. Image alt text, comments, inferred descriptions, dates, and source-site links are not added.

## Optional Pinterest API mode

The repository also includes an API-based exporter for users with an approved Pinterest developer app and a token containing `boards:read` and `pins:read` scopes.

```powershell
$env:PINTEREST_ACCESS_TOKEN="pina_your_token_here"
npm run pinterest-export -- --board "https://www.pinterest.com/user/board-name/"
```

The token is read only from the environment and is never written to disk. Browser mode is simpler for most personal exports.

## Troubleshooting

### The board or sections are incomplete

Confirm that the board is fully visible in the opened browser before pressing Enter. Pinterest lazy-loads Pins while scrolling, so very large boards can take time. Increase the limit with `--max-scrolls 500` if necessary.

### Edge or Chrome was not found

Pass the executable explicitly:

```powershell
npm run pinterest-scrape -- --board "https://www.pinterest.com/user/board-name/" --browser-path "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

### Start with a fresh login

Close the exporter, delete `.browser-profile`, and run the command again. Never commit or share that directory because it contains browser session data.

### A Pin has no description

Some Pinterest records genuinely contain no description. The exporter deliberately leaves these blank instead of inventing text.

## Development

```powershell
npm test
```

The test suite covers URL validation, media selection, Markdown formatting, filename safety, and incremental reruns.

## Responsible use

Export only boards and media you are authorized to access and respect creators' rights and Pinterest's applicable terms. This project is not affiliated with Pinterest.

## License

[MIT](LICENSE)
