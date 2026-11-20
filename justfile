set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]

# List the recipes.
default:
    @just --list

# Run the tests.
test:
    bun install --frozen-lockfile --ignore-scripts
    bun run test

# Run the tests and the type check.
check: test
    bun run check
