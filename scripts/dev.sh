#!/bin/sh
# Dev loop: TypeScript compiler in watch mode + Node auto-restart.
# (tsc is used instead of tsx/esbuild because NestJS DI needs decorator metadata.)
set -e
npx tsc -p tsconfig.build.json
npx tsc -p tsconfig.build.json --watch --preserveWatchOutput &
TSC_PID=$!
trap 'kill $TSC_PID 2>/dev/null' EXIT INT TERM
node --env-file-if-exists=.env --enable-source-maps --watch dist/main.js
