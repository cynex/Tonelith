# Tonelith

Tonelith is a small, local photo developer that runs on your own computer. It is a Python (Flask) server with a
browser-based interface: you organize photos into libraries, adjust color and tone with a set of sliders, and
export the finished images. Nothing is uploaded anywhere - the server only listens on `127.0.0.1`.

## Features

- **Libraries** - group photos into named libraries, with optional location (city, region, country). Copy images
  between libraries, mark featured images, and browse with thumbnails.
- **Wide format support**
  - RAW: CR2/CR3, NEF/NRW, ARW/SR2/SRF, DNG, ORF, RAF, RW2, PEF, and many more (decoded with LibRaw via `rawpy`)
  - Standard: JPEG, PNG, TIFF, BMP, WebP, GIF, JPEG 2000, and HEIC/HEIF/AVIF
- **Non-destructive editing** - adjustments are stored as settings in a local catalog; your original files are
  never modified.
- **Develop controls**
  - *White Balance*: Temperature, Tint
  - *Tone*: Exposure, Contrast, Highlights, Midtones, Shadows
  - *Color*: Saturation, Vibrance
  - *Color Balance*: hue and amount for Shadows, Midtones and Highlights
  - *Sharpening*: Amount, Radius
  - *Noise Reduction*: Luminance, Color
- **Fast previews** - edits render against a cached 1800 px proxy, with on-demand full-resolution region rendering
  for zooming.
- **Batch settings** - apply settings to many images at once.
- **Export** - full-resolution export to JPEG, PNG, TIFF (8/16-bit) or WebP, with quality, file suffix and
  long-edge resize options, plus progress and cancel.
- **Installable** - includes a web app manifest and icons, so Chrome/Edge can install it as its own app window.

## Requirements

| | Windows (PC) | macOS |
|---|---|---|
| OS | Windows 10 or 11 | A recent macOS (Intel or Apple Silicon) |
| Python | 3.10 or newer | 3.10 or newer |
| Shell | `cmd` / PowerShell (uses `.bat` scripts) | Terminal (uses `.sh` scripts, bash) |
| Browser | Any modern browser (Chrome, Edge, Firefox) | Any modern browser (Safari, Chrome, Firefox) |
| Disk | ~500 MB for the virtual environment, plus space for the cache | same |

Python packages (installed automatically into a private `.venv` from `requirements.txt`):
`flask`, `numpy`, `pillow`, `pillow-heif`, `opencv-python-headless`, `rawpy`.

If a package has no prebuilt wheel for your Python version, install Python 3.12 and run setup again.

## Setup and running

### Windows

1. Install Python 3.10+ from <https://www.python.org/downloads/> and tick **Add python.exe to PATH**. (Or skip this
   step: `setup.bat` offers to install Python 3.12 with `winget` if Python is missing.)
2. Open the repository folder and double-click **`setup.bat`** (or run it from a terminal). It will:
   1. find Python 3.10+,
   2. create the `.venv` virtual environment,
   3. install the packages,
   4. verify that everything imports.
3. Double-click **`run.bat`**. If setup has not been run yet, it runs it for you first. Your browser opens at
   <http://127.0.0.1:5174/>.

### macOS

1. Open Terminal and go to the app folder:
   ```bash
   cd path/to/Tonelith
   ```
2. Make the scripts executable (first time only, if needed):
   ```bash
   chmod +x setup.sh run.sh
   ```
3. Run setup:
   ```bash
   ./setup.sh
   ```
   If Python 3.10+ is missing and [Homebrew](https://brew.sh) is installed, the script offers to run
   `brew install python@3.12`. Otherwise install Python from <https://www.python.org/downloads/>. After a fresh
   Python install, open a new Terminal window and run `./setup.sh` again.
4. Start the app:
   ```bash
   ./run.sh
   ```
   Your browser opens at <http://127.0.0.1:5174/>.

The `./setup.sh` script also works on Linux.

### Manual setup (either platform)

```bash
python -m venv .venv
# Windows:  .venv\Scripts\activate        macOS/Linux:  source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

### Command-line options

Arguments are passed through `run.bat` / `run.sh` to `app.py`:

| Option | Description |
|---|---|
| `--port <number>` | Port to listen on (default `5174`) |
| `--no-browser` | Do not open the browser automatically |

Example: `./run.sh --port 5200 --no-browser`

If a previous Tonelith server is still running on the chosen port, it is stopped automatically. If another program
holds the port, Tonelith tells you and exits; pick a different port with `--port`.

### Environment variables

| Variable | Purpose |
|---|---|
| `TONELITH_DATA` | Where the catalog database and caches are stored (default: `data/` in the app folder) |
| `TONELITH_INFO` | Folder containing `application_info.html`, the text shown in the About window |

## Where things are stored

- `data/tonelith.db` - the SQLite catalog (libraries, image references, develop settings)
- `data/temp/` - proxy and thumbnail caches (can be cleared from within the app)
- `exports/` - default export destination

All of these are created on first run and are excluded from git.

## Project layout

```
./
├── app.py              Flask server and API routes
├── tonelith/
│   ├── db.py           SQLite catalog
│   ├── imaging.py      Decoding, develop pipeline, previews, export
│   ├── settings.py     Develop-settings schema shared by server and UI
│   └── portutil.py     Port checks and replacing a stale server
├── static/             Browser UI (index.html, app.js, style.css, icons, manifest)
├── images/             Application icons (.ico, .icns, .png)
├── info/               About-window content
├── tools/make_icons.py Icon generation helper
├── requirements.txt
├── setup.bat / setup.sh
└── run.bat / run.sh
```

## Security note

The server binds to `127.0.0.1` only and rejects requests whose Host or Origin is not local, which protects
against DNS-rebinding and cross-site requests. Do not expose it to a network.
