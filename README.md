# Tonelith

Tonelith is a small, local photo developer that runs on your own computer. It is a Python (Flask) server with a
browser-based interface: you organize photos into libraries, adjust color and tone with a set of sliders, and
export the finished images. Nothing is uploaded anywhere - the server only listens on `127.0.0.1`.

## Features

- **Libraries** - group photos into named libraries, with optional location (city, region, country). Copy images
  between libraries, mark featured images, and browse with thumbnails.
- **File browser** - Add files / Add folder open a browser for any folder on the computer, with a files or
  thumbnail view, a favorites list (kept in the browser), and "show all files" / sub-folder options.
- **Import movie frames** - pull still frames out of a movie file (every frame, or one every N seconds, as JPEG or
  PNG). Extraction runs in the background; frames are added to the library as they are written and a progress bar
  with a stop button floats at the bottom of the Library window.
- **Wide format support**
  - RAW: CR2/CR3, NEF/NRW, ARW/SR2/SRF, DNG, ORF, RAF, RW2, PEF, and many more (decoded with LibRaw via `rawpy`)
  - Standard: JPEG, PNG, TIFF, BMP, WebP, GIF, JPEG 2000, and HEIC/HEIF/AVIF
- **Non-destructive editing** - adjustments are stored as settings in a local catalog; your original files are
  never modified.
- **Develop controls**
  - *White Balance*: Temperature, Tint
  - *Tone*: Exposure, Contrast, Highlights, Midtones, Shadows, Whites, Blacks
  - *Presence*: Texture, Clarity, Dehaze, Vibrance, Saturation
  - *Color Balance*: hue and amount for Shadows, Midtones and Highlights
  - *Sharpening*: Amount, Radius
  - *Noise Reduction*: Luminance, Color
- **Fast previews** - edits render against a cached 1800 px proxy, with on-demand full-resolution region rendering
  for zooming.
- **Batch settings** - copy and paste settings, or apply them to many images at once.
- **Presets** - save an image's settings as a named preset and apply it to the selected images from the Presets
  dropdown in the Develop panel.
- **Slider strength** - every slider has a cog that opens a strength multiplier (0.01x to 3x), so you can make any
  adjustment more or less pronounced. Temperature and tint curves are fitted to Lightroom output.
- **Image actions** - right-click or use the Actions menu to copy settings, copy the edited image to the clipboard,
  feature an image, add images to another library, remove them from the library, or delete the files from disk
  (permanent; asks first).
- **Interface settings** - the Settings button holds browser-side options, such as pan momentum (velocity and
  damping) and how often the zoomed view refreshes while dragging.
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

Importing movie frames decodes video with the FFmpeg built into the standard `opencv-python-headless` wheels, so no
separate FFmpeg install is needed.

If a package has no prebuilt wheel for your Python version, install Python 3.12 and run setup again.

## Download the app (no Python needed)

Ready-made apps are built automatically on GitHub (**Actions > Build apps**, or the **Releases** page for tagged
versions):

- **Windows** - unzip `Tonelith-windows.zip` and run `Tonelith.exe`. A small console window stays open while Tonelith
  is running; it closes by itself when you close the browser (or close it to quit). Windows SmartScreen may warn about an unrecognised app: choose **More info > Run
  anyway**.
- **macOS (Apple Silicon)** - unzip `Tonelith-macos-arm64.zip`, then **right-click `Tonelith.app` > Open** the first
  time. It quits by itself when you close the browser window.

These apps are not code-signed. They keep their data in your user folders instead of next to the program:
the catalog and caches in `%APPDATA%\Tonelith` (Windows) or `~/Library/Application Support/Tonelith` (macOS), and
exports and extracted movie frames in `Pictures/Tonelith`.

To build an app yourself: `pip install -r requirements.txt -r requirements-build.txt`, then
`pyinstaller tonelith.spec --noconfirm`. The result is in `dist/` (it has to be built on the platform it is for).

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
| `--keep-running` | Keep the server running after the browser is closed (see below) |

Example: `./run.sh --port 5200 --no-browser`

If a previous Tonelith server is still running on the chosen port, it is stopped automatically. If another program
holds the port, Tonelith tells you and exits; pick a different port with `--port`.

### Quitting

Tonelith shuts itself down about 10-15 seconds after the last browser window or tab showing it is closed, so there is
nothing to stop by hand. A page refresh is fine. It never quits while an export or a movie import is still running
(it waits for them to finish), and it also exits if no page opens within about a minute and a half of starting. To keep
the server up regardless, for example to use it from a second window later, start it with `--keep-running` or set
`TONELITH_KEEP_RUNNING=1`. Ctrl+C always quits.

### Environment variables

| Variable | Purpose |
|---|---|
| `TONELITH_DATA` | Where the catalog database and caches are stored (default: `data/` in the app folder) |
| `TONELITH_KEEP_RUNNING` | Set to `1` to keep the server running after the browser is closed |
| `TONELITH_INFO` | Folder containing `application_info.html`, the text shown in the About window |

## Where things are stored

- `data/tonelith.db` - the SQLite catalog (libraries, image references, develop settings)
- `data/temp/` - proxy and thumbnail caches (can be cleared from within the app)
- `data/prefs.json` - app-wide slider strength multipliers (created when you change one)
- `exports/` - default export destination
- `movie_frames/` - default destination for frames extracted from movies (a new folder per import)

All of these are created on first use and are excluded from git. Browser-side preferences (interface settings,
favorite folders, which panel sections are open) are stored in the browser's local storage, not in the app folder.

## Project layout

```
./
├── app.py              Flask server and API routes
├── tonelith/
│   ├── db.py           SQLite catalog
│   ├── imaging.py      Decoding, develop pipeline, previews, export
│   ├── lifecycle.py    Shuts the server down when the browser is closed
│   ├── movies.py       Extracting still frames from movie files
│   ├── paths.py        Where bundled files and user data live (source run vs packaged app)
│   ├── settings.py     Develop-settings schema shared by server and UI
│   └── portutil.py     Port checks and replacing a stale server
├── static/             Browser UI (index.html, app.js, style.css, icons, manifest)
├── images/             Application icons (.ico, .icns, .png)
├── info/               About-window content
├── tools/make_icons.py Icon generation helper
├── requirements.txt
├── requirements-build.txt   PyInstaller (only needed to build the apps)
├── tonelith.spec       PyInstaller recipe for the Windows and macOS apps
├── .github/workflows/  Builds the apps on GitHub
├── setup.bat / setup.sh
└── run.bat / run.sh
```

## Security note

The server binds to `127.0.0.1` only and rejects requests whose Host or Origin is not local, which protects
against DNS-rebinding and cross-site requests. Do not expose it to a network.
