set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]

# List the recipes.
default:
    @just --list

# Build the site.
build:
    bun install --frozen-lockfile --ignore-scripts
    bun run build

# Run the tests.
test: build
    bun run test

# Run the perf tests.
perf: build
    bun run perf

# Run the tests and the type check.
check: test
    bun run check
