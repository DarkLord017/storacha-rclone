# Storacha Backend for rclone - Complete Setup Guide

This guide walks through integrating the Storacha JavaScript SDK with rclone using v8go.

## Overview

The Storacha backend allows rclone to interact with the Storacha Network using their official JavaScript SDK. Since the SDK is JavaScript-based and rclone is written in Go, we use v8go to embed a V8 JavaScript engine and bridge the two languages.

## Architecture

```
┌─────────────┐
│   rclone    │
│   (Go)      │
└──────┬──────┘
       │
       │ calls
       ▼
┌─────────────────┐
│  storacha.go    │  ← Main Go implementation
│  v8_helpers.go  │  ← V8 utility functions
└──────┬──────────┘
       │
       │ v8go
       ▼
┌─────────────────────┐
│   V8 JavaScript     │
│   Engine            │
└──────┬──────────────┘
       │
       │ executes
       ▼
┌─────────────────────┐
│   bridge.js         │  ← JavaScript bridge layer
│   +                 │
│   storacha-sdk-     │  ← Bundled Storacha SDK
│   bundle.js         │
└─────────────────────┘
```

## Prerequisites

1. **Go 1.21+** (already installed for rclone development)
2. **Node.js 18+** and **npm** (for bundling the SDK)
3. **v8go** (installed via go.mod)

## Setup Steps

### Step 1: Install Node.js Dependencies

```bash
cd backend/storacha
npm install
```

This installs:
- `@storacha/client` - The official Storacha JavaScript client
- `esbuild` - Fast JavaScript bundler

### Step 2: Bundle the JavaScript SDK

```bash
cd backend/storacha
npm run bundle
```

This creates:
- `storacha-sdk-bundle.js` - Bundled Storacha SDK
- `storacha-bundle-combined.js` - SDK + bridge.js combined (embedded in Go)

### Step 3: Build rclone

```bash
# From the repository root
go build -o bin/rclone .
```

The `//go:embed` directive in `storacha_v8.go` automatically embeds the bundled JavaScript.

## Configuration

### Basic Configuration

Create a remote using `rclone config`:

```bash
$ rclone config

n) New remote
s) Set configuration password
q) Quit config
n/s/q> n

name> my-storacha

Type of storage to configure.
Choose a number from below, or type in your own value
[snip]
XX / Storacha
   \ "storacha"
[snip]
Storage> storacha

Storacha space DID to operate on.
Enter a value.
space_did> did:key:z6Mk...

Email for Storacha authentication (optional).
Enter a value. Press Enter to leave empty.
email> your@email.com

Edit advanced config?
y/n> n

Remote configured.
```

### Configuration Options

| Option | Required | Description |
|--------|----------|-------------|
| `space_did` | Yes | The DID (Decentralized Identifier) of your Storacha space |
| `email` | No | Email for authentication (will prompt on first use if not provided) |

## Authentication

The Storacha SDK requires authentication. There are two methods:

### Method 1: Email Authentication (Recommended)

1. Configure the backend with your email
2. On first use, you'll receive an email with a login link
3. Click the link to authorize the rclone agent
4. Credentials are stored in the V8 context

### Method 2: Delegation Proofs (Advanced)

For automated/server deployments, you can use delegation proofs:

```bash
# Generate a delegation using the Storacha CLI
storacha delegation create did:key:your-agent-did --can 'space/*' > delegation.proof

# Load the proof (this would require additional code)
```

## Usage Examples

### Upload a File

```bash
rclone copy local-file.txt my-storacha:remote-path/
```

### Upload a Directory

```bash
rclone copy ./my-folder my-storacha:backup/
```

### List Uploads

```bash
rclone ls my-storacha:
```

### Remove an Upload

```bash
rclone delete my-storacha:path/to/file.txt
```

## How It Works

### 1. Initialization

When you create a Storacha remote:

1. rclone creates a V8 isolate (JavaScript VM instance)
2. Loads the bundled Storacha SDK into the V8 context
3. Calls `storachaBridge.initClient()` with your configuration
4. The SDK authenticates and selects your space

### 2. Upload Flow

When uploading a file:

1. rclone reads the file data in Go
2. Converts data to JSON-safe format
3. Calls `storachaBridge.uploadFile()` via v8go
4. JavaScript SDK uploads to Storacha network
5. Returns CID (Content Identifier) to Go
6. rclone stores the CID for future reference

### 3. Data Conversion

Data flows between Go and JavaScript:

```
Go ([]byte) → JSON encode → JavaScript (Uint8Array) → Blob → Upload
```

## Files Created

```
backend/storacha/
├── storacha.go               # Original CLI-based implementation
├── storacha_v8.go            # New v8go implementation  
├── v8_helpers.go             # V8 utility functions
├── bridge.js                 # JavaScript bridge layer
├── sdk-wrapper.js            # SDK export wrapper
├── bundle.js                 # Bundler script
├── package.json              # npm dependencies
├── storacha-sdk-bundle.js    # Generated: Bundled SDK
├── storacha-bundle-combined.js # Generated: SDK + bridge
└── README.md                 # Documentation
```

## Important Notes

### Binary Size

The V8 engine and bundled SDK significantly increase binary size:
- v8go: ~50MB (includes V8 engine)
- Bundled SDK: ~2-5MB (depends on tree-shaking)
- **Total impact: ~50-55MB**

### Performance Considerations

1. **Go ↔ JS Bridge Overhead**: Each call crosses the V8 boundary
2. **Data Serialization**: Data must be JSON-serialized for transport
3. **Async Handling**: Promise resolution requires polling (10ms intervals)

### Limitations

1. **No Streaming Downloads**: The current implementation doesn't support reading files back (would require IPFS gateway integration)
2. **Memory Usage**: Files are loaded entirely into memory before upload
3. **No Progress Callbacks**: Progress tracking during uploads is limited
4. **Platform Support**: v8go has platform-specific binaries (Linux, macOS)

### Platform Compatibility

v8go provides pre-built binaries for:
- ✅ Linux (x86_64, ARM64)
- ✅ macOS (x86_64, ARM64)
- ❌ Windows (not currently supported by v8go)

## Development Workflow

### Making Changes to JavaScript

1. Edit `bridge.js` or `sdk-wrapper.js`
2. Run `npm run bundle`
3. Rebuild rclone: `go build`

### Testing

```bash
# Test the bundle creation
cd backend/storacha
npm run bundle

# Test the Go code
cd ../..
go test ./backend/storacha/...

# Integration test
rclone test memory: my-storacha: --test-file uploads/test.txt
```

### Debugging

Enable verbose logging:

```bash
rclone copy test.txt my-storacha: -vv
```

## Troubleshooting

### "Client not initialized" Error

**Cause**: The V8 context failed to initialize the Storacha client.

**Solution**: 
1. Check that `space_did` is correct
2. Ensure the space exists and you have access
3. Verify authentication (try logging in again)

### "Promise timeout" Error

**Cause**: JavaScript async operation took too long.

**Solution**:
1. Check network connectivity
2. Increase timeout in code if needed
3. Check Storacha service status

### Bundle Not Found

**Cause**: `storacha-bundle-combined.js` wasn't generated or embedded.

**Solution**:
```bash
cd backend/storacha
npm run bundle
# Rebuild
go build
```

### V8 Crashes

**Cause**: Memory corruption or invalid V8 API usage.

**Solution**:
1. Ensure thread-safety (V8 is single-threaded)
2. Check that Isolate.Dispose() is called properly
3. Update v8go: `go get -u rogchap.com/v8go`

## Alternative Approaches Considered

### 1. CGo + Node.js Embedding
❌ Too complex, larger binary size

### 2. HTTP API Wrapper
❌ Requires running separate Node.js process

### 3. Pure Go Rewrite of SDK
❌ Too much maintenance, SDK complexity

### 4. CLI Wrapper (Current)
✅ Simple but limited, requires CLI installation

### 5. v8go Integration (This Implementation)
✅ Good balance of functionality and complexity

## Future Improvements

1. **Streaming Support**: Implement chunked uploads for large files
2. **Download Support**: Add IPFS gateway integration for reading files
3. **Progress Tracking**: Implement upload progress callbacks
4. **Caching**: Cache V8 contexts for better performance
5. **Web Workers**: Use V8 worker threads for parallel uploads
6. **Better Error Handling**: More detailed error messages from JS
7. **Windows Support**: Wait for v8go Windows support or alternative

## Resources

- [v8go Documentation](https://pkg.go.dev/rogchap.com/v8go)
- [Storacha Client Docs](https://storacha.network/docs)
- [rclone Backend Development](https://rclone.org/dev/)

## Contributing

To contribute to this backend:

1. Make sure you understand both Go and JavaScript
2. Test changes thoroughly with the bundling workflow
3. Update documentation for any API changes
4. Consider binary size impact of SDK changes

## License

This implementation follows rclone's license (MIT).
