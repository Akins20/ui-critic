#!/usr/bin/env node
// `npx uicritic` runs the ui-critic command. The unscoped name ui-critic belongs to a
// different package on npm, so the tool lives at @akins20/ui-critic and this name
// only points at it.
await import("@akins20/ui-critic/bin/ui-critic.mjs");
