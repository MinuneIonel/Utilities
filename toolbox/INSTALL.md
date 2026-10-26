# Installing Toolbox

Download the file for your computer from the **Assets** list below, then follow the steps for it. Toolbox isn't signed with a paid Apple or Microsoft certificate, so the first launch takes one extra click.

| Computer | File |
| --- | --- |
| Mac with Apple Silicon (M1 or newer) | `Toolbox-…-mac-arm64.dmg` |
| Windows 10 or 11 (64-bit) | `Toolbox-…-win-x64.exe` |
| Linux (64-bit) | `Toolbox-…-linux-x86_64.AppImage` |

## Mac

1. Open the `.dmg` and drag **Toolbox** into **Applications**.
2. Open Toolbox from Applications. macOS says it can't check the app for malware: click **Done** (or **OK**).
3. Open **System Settings → Privacy & Security**, scroll down to the line about Toolbox, and click **Open Anyway**. Confirm with your password.

On macOS 14 (Sonoma) or older you can instead right-click Toolbox in Applications, choose **Open**, then **Open** again.

You only do this once. If macOS ever says Toolbox "is damaged", run this in Terminal and open it again:

```sh
xattr -cr /Applications/Toolbox.app
```

## Windows

1. Run the `.exe`. If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**.
2. Toolbox installs for your user (no admin needed) and opens. It's in the Start menu afterwards.

## Linux

1. Make the file executable: right-click → Properties → Permissions → "Allow executing", or `chmod +x Toolbox-*.AppImage`.
2. Double-click it, or run `./Toolbox-*.AppImage`.

If it doesn't start: on Ubuntu 22.04 and newer install FUSE with `sudo apt install libfuse2` (`libfuse2t64` on 24.04). If it then complains about the sandbox, start it with `./Toolbox-*.AppImage --no-sandbox`.

## Good to know

- ffmpeg comes inside the app. The Download node fetches yt-dlp the first time you use it and keeps it up to date, since sites like YouTube change often.
- iPhone photos (HEIC) open in the Mac app. On Windows and Linux, export them as JPEG first.
- Toolbox updates itself: when a newer version is out, press **Update** in its top bar, then **Restart to update**. Your graph stays as it was. On a Mac this works once Toolbox is in Applications.
- ProRes encodes on Apple Silicon's media engine on a Mac and in software elsewhere. HEVC uses an NVIDIA, Intel or AMD GPU on Windows when there is one, otherwise software.
