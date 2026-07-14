# Build Resources

This directory contains resources used by `electron-builder` to package the application.

## Required before first `npm run dist`

### Icons

- `icon.ico` (Windows) -- 256x256 .ico format with multiple sizes embedded
- `icon.icns` (macOS) -- .icns format with multiple sizes
- `icon.png` (Linux) -- 512x512 PNG

If icons are missing, electron-builder will use a default Electron logo (ugly, but functional).

Quickest way to create all three from a single 1024x1024 PNG:
```bash
npx electron-icon-builder --input=source-icon.png --output=build --flatten
```

### Code Signing (strongly recommended for enterprise distribution)

Without a code-signing certificate:
- Windows SmartScreen shows "Unknown Publisher" warning
- macOS Gatekeeper blocks the app entirely
- Enterprise EDR products (CrowdStrike, etc.) may flag unsigned Electron binaries

With a cert (pfx for Windows, .p12 + notarization for macOS):
```bash
# Windows
$env:CSC_LINK = "path/to/cert.pfx"
$env:CSC_KEY_PASSWORD = "password"
npm run dist:win

# macOS
export CSC_LINK="path/to/cert.p12"
export CSC_KEY_PASSWORD="password"
export APPLE_ID="your@apple.id"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
npm run dist:mac
```

### `entitlements.mac.plist`

Already present. Defines the macOS sandbox entitlements for code-signed builds.
Do not remove -- required for notarization.
