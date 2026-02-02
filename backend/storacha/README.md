# Storacha Backend for rclone

This backend integrates the Storacha JavaScript SDK with rclone using v8go.

## Setup Instructions

### 1. Install Node.js and npm (if not already installed)

### 2. Bundle the Storacha SDK

Since the Storacha SDK is a JavaScript module, we need to bundle it for use with v8go:

```bash
cd backend/storacha
npm init -y
npm install @storacha/client esbuild
```

### 3. Create a bundler script

Create `bundle.js`:

```javascript
// bundle.js
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['./sdk-wrapper.js'],
  bundle: true,
  format: 'iife',
  globalName: 'StorachaClient',
  outfile: 'storacha-sdk-bundle.js',
  platform: 'browser',
  target: 'es2020'
}).catch(() => process.exit(1));
```

### 4. Create SDK wrapper

Create `sdk-wrapper.js`:

```javascript
// sdk-wrapper.js
import * as Client from '@storacha/client';
export default Client;
```

### 5. Build the bundle

```bash
node bundle.js
```

This will create `storacha-sdk-bundle.js` which can be embedded in the Go binary.

### 6. Embed the bundle in Go

The bundle will be embedded using `//go:embed` directive in the Go code.

## Architecture

1. **v8go**: Provides a V8 JavaScript engine instance in Go
2. **bridge.js**: JavaScript bridge layer that provides a simplified API
3. **storacha-sdk-bundle.js**: Bundled Storacha SDK
4. **storacha.go**: Go code that manages the V8 context and calls JS functions

## Authentication

The Storacha SDK requires authentication. Users can:

1. Login via email: `rclone config` will prompt for email and handle the auth flow
2. Use delegations: Advanced users can provide delegation proofs

## Configuration Options

- `space_did`: The DID of the space to use for storage
- `email`: Email for authentication (optional, will prompt on first use)
- `proof`: Path to delegation proof file (advanced usage)

## Limitations

- The JavaScript SDK is designed for browser/Node.js, so some features may not work
- Binary size will increase due to V8 engine and bundled SDK
- Performance overhead from Go↔JS bridge
