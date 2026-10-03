# Brand icons

The three Icon Composer projects are the sources for iOS, Linux, Windows, and web icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project uses `text.svg` for a plain black layer over a black background.

Run `vp run icons:export` from the repository root to regenerate the tracked macOS, iOS, Linux, Windows, and web assets. The development web exports are also copied to `apps/web/public` for the browser favicon and splash screen. Run `vp run icons:check` to verify that the generated assets and public copies match their sources without changing files.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

`macos-icon.svg` is the source for the plain black macOS icons in all three variants.
`vp run icons:export` renders it alongside the other assets, and `vp run icons:check`
verifies it. It has a 1024×1024 canvas with an 824×824 black body inset 100 pixels,
a transparent margin, and a subtle shadow.

This SVG replaces Icon Composer's manual pre-Tahoe export, which can produce a
full-bleed image even when legacy metrics are selected. Edit the vector source and
regenerate; do not edit the generated PNG or ICO files directly.

## Android launcher and splash artwork

Run `vp run icons:export:android` to regenerate the plain black adaptive launcher and splash canvases. Android supplies their masks. The monochrome launcher and notification images supply a solid silhouette that Android tints itself.
