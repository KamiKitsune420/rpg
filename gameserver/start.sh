#!/usr/bin/env bash
set -e

# Check Node.js is installed
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js is not installed or not in PATH."
    echo "Install it from https://nodejs.org or via your package manager."
    exit 1
fi

# Install dependencies if node_modules is missing
if [ ! -d "node_modules" ]; then
    echo "[INFO] node_modules not found. Running npm install..."
    npm install
fi

# Check .env exists, create from example if not
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo "[INFO] No .env file found. Copying from .env.example..."
        cp ".env.example" ".env"
        echo "[ACTION REQUIRED] Open .env and fill in JWT_SECRET, ADMIN_KEY, and BASE_URL."
        echo "                  Then run this script again."
        exit 0
    else
        echo "[ERROR] No .env or .env.example found."
        exit 1
    fi
fi

echo ""
echo " Game Server starting..."
echo " Listening on http://localhost:3000"
echo " Press Ctrl+C to stop."
echo ""

npm start
