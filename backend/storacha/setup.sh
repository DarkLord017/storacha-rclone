#!/bin/bash
# Quick setup script for Storacha backend development

set -e

echo "========================================="
echo "Storacha Backend Setup for rclone"
echo "========================================="
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed!"
    echo "Please install Node.js 18+ from https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js found: $(node --version)"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed!"
    exit 1
fi

echo "✅ npm found: $(npm --version)"

# Check for Go
if ! command -v go &> /dev/null; then
    echo "❌ Go is not installed!"
    exit 1
fi

echo "✅ Go found: $(go version)"
echo ""

# Navigate to storacha backend directory
cd "$(dirname "$0")"

# Install npm dependencies
echo "📦 Installing npm dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install npm dependencies"
    exit 1
fi

echo "✅ npm dependencies installed"
echo ""

# Bundle the SDK
echo "📦 Bundling Storacha SDK..."
npm run bundle

if [ $? -ne 0 ]; then
    echo "❌ Failed to bundle SDK"
    exit 1
fi

echo "✅ SDK bundled successfully"
echo ""

# Check if bundle file was created
if [ ! -f "storacha-bundle-combined.js" ]; then
    echo "❌ Bundle file not found!"
    exit 1
fi

BUNDLE_SIZE=$(du -h storacha-bundle-combined.js | cut -f1)
echo "📊 Bundle size: $BUNDLE_SIZE"
echo ""

# Build rclone (optional)
echo "Would you like to build rclone now? (y/n)"
read -r response

if [[ "$response" =~ ^[Yy]$ ]]; then
    echo "🔨 Building rclone..."
    cd ../..
    go build -o bin/rclone .
    
    if [ $? -eq 0 ]; then
        echo "✅ rclone built successfully!"
        echo "Binary location: bin/rclone"
    else
        echo "❌ Build failed"
        exit 1
    fi
fi

echo ""
echo "========================================="
echo "✅ Setup complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Configure a Storacha remote: bin/rclone config"
echo "2. Test the backend: bin/rclone ls your-storacha-remote:"
echo ""
echo "For more information, see SETUP_GUIDE.md"
