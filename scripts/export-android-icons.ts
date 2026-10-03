#!/usr/bin/env node

// Renders the plain black Android launcher and splash artwork.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

// Android applies its own mask to these full-bleed black canvases.
const ADAPTIVE_CANVAS = 432;
const SPLASH_CANVAS = 1152;
const OUTPUT_DIRECTORY = "apps/mobile/assets";

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

const solidCanvas = (layer: string, size: number, background = "#000000") =>
  Effect.tryPromise({
    try: () =>
      sharp({ create: { width: size, height: size, channels: 4, background } })
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const outputs = [
    ["android-icon-foreground.png", yield* solidCanvas("foreground", ADAPTIVE_CANVAS)],
    ["android-icon-mark.png", yield* solidCanvas("monochrome", ADAPTIVE_CANVAS)],
    // Android uses the alpha silhouette and applies its own notification color.
    ["android-notification-icon.png", yield* solidCanvas("notification", 96, "#ffffff")],
    ["android-icon-background-dev.png", yield* solidCanvas("dev-background", ADAPTIVE_CANVAS)],
    [
      "android-icon-background-nightly.png",
      yield* solidCanvas("nightly-background", ADAPTIVE_CANVAS),
    ],
    ["android-splash-icon-dev.png", yield* solidCanvas("dev-splash", SPLASH_CANVAS)],
    ["android-splash-icon-nightly.png", yield* solidCanvas("nightly-splash", SPLASH_CANVAS)],
    ["android-splash-icon-prod.png", yield* solidCanvas("prod-splash", SPLASH_CANVAS)],
  ] as const;
  for (const [name, contents] of outputs) {
    yield* fs.writeFile(path.join(repositoryRoot, OUTPUT_DIRECTORY, name), contents);
    yield* Console.log(`wrote ${OUTPUT_DIRECTORY}/${name}`);
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
