#!/usr/bin/env bash
# Tata first-time setup — run this after cloning the repo.
#   ./setup.sh
# It checks for Node and pnpm, installs dependencies if needed, then
# launches the interactive setup CLI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
info()  { printf "  %s\n" "$*"; }
warn()  { printf "\033[33m  %s\033[0m\n" "$*"; }
err()   { printf "\033[31m  %s\033[0m\n" "$*"; }

echo
bold "🐱  Tata setup"
echo

# --- Node ---
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed."
  info "Install Node 20+ from https://nodejs.org/ (or via your package manager) and run ./setup.sh again."
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node.js $NODE_MAJOR detected. Tata needs Node 20 or newer."
  info "Upgrade Node (https://nodejs.org/) and run ./setup.sh again."
  exit 1
fi
info "Node $(node -v) ✓"

# --- pnpm ---
if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm is not installed."
  if command -v corepack >/dev/null 2>&1; then
    info "Enabling pnpm via corepack…"
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  err "Couldn't find pnpm and couldn't auto-install it."
  info "Install pnpm: https://pnpm.io/installation  — then run ./setup.sh again."
  exit 1
fi
info "pnpm $(pnpm -v) ✓"

# --- Dependencies ---
if [ ! -d node_modules ]; then
  echo
  bold "Installing dependencies (first run — this may take a minute)…"
  pnpm install
fi

# --- Interactive setup ---
echo
exec pnpm setup:cli
