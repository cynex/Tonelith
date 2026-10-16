# PyInstaller build recipe for Tonelith (Windows and macOS).
#   pip install -r requirements.txt -r requirements-build.txt
#   pyinstaller tonelith.spec --noconfirm
# Windows: dist/Tonelith/Tonelith.exe     macOS: dist/Tonelith.app
import sys

from PyInstaller.utils.hooks import collect_all

datas = [("static", "static"), ("images", "images"), ("info", "info")]
binaries, hiddenimports = [], []
for pkg in ("rawpy", "pillow_heif"):  # native libraries these packages ship alongside their Python code
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h
if sys.platform == "darwin":
    hiddenimports.append("tonelith.macapp")  # Dock icon / Quit handling (imported only in the packaged Mac app)

a = Analysis(
    ["app.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "scipy", "pandas", "IPython", "pytest"],
)
pyz = PYZ(a.pure)

# Windows keeps a small console window: it shows the server is running and closing it quits the app.
# macOS runs as a normal windowless app: clicking the Dock icon opens the browser, Quit stops it (tonelith/macapp.py).
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Tonelith",
    console=sys.platform != "darwin",
    icon="images/Tonelith.icns" if sys.platform == "darwin" else "images/Tonelith.ico",
)
coll = COLLECT(exe, a.binaries, a.datas, name="Tonelith")

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="Tonelith.app",
        icon="images/Tonelith.icns",
        bundle_identifier="app.tonelith.Tonelith",
        info_plist={"CFBundleDisplayName": "Tonelith", "NSHighResolutionCapable": True},
    )
