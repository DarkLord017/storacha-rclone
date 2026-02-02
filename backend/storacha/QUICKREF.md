# Storacha Backend - Quick Reference

## File Structure

```
backend/storacha/
├── storacha.go                    # Original CLI-based implementation
├── storacha_v8.go                 # New v8go-based implementation ⭐
├── v8_helpers.go                  # V8 utility functions
├── bridge.js                      # JavaScript bridge to SDK
├── sdk-wrapper.js                 # Wraps @storacha/client for bundling
├── bundle.js                      # Build script for bundling
├── package.json                   # npm dependencies
├── setup.sh                       # Automated setup script ⭐
├── README.md                      # Basic info
├── SETUP_GUIDE.md                 # Complete setup guide ⭐
└── Generated files:
    ├── storacha-sdk-bundle.js     # Bundled SDK (don't edit)
    └── storacha-bundle-combined.js # SDK + bridge (embedded in Go)
```

## Quick Commands

### Setup
```bash
# One-time setup
cd backend/storacha
./setup.sh

# Manual setup
npm install
npm run bundle
```

### Development
```bash
# After editing JavaScript
npm run bundle

# After editing Go
go build

# Full rebuild
npm run bundle && go build
```

### Testing
```bash
# Configure remote
rclone config

# Test upload
rclone copy test.txt my-storacha:

# Test list
rclone ls my-storacha:

# Verbose mode
rclone -vv copy test.txt my-storacha:
```

## Implementation Comparison

### CLI-based (`storacha.go`)

**Pros:**
- ✅ Simple implementation
- ✅ Small binary size
- ✅ Easy to debug
- ✅ Works on all platforms

**Cons:**
- ❌ Requires CLI installation
- ❌ Limited to CLI features
- ❌ Process overhead
- ❌ CLI must be in PATH

**Use when:**
- Users already have Storacha CLI
- Binary size is critical
- Simple use cases

### SDK-based (`storacha_v8.go`)

**Pros:**
- ✅ No external dependencies
- ✅ Full SDK features
- ✅ Direct API access
- ✅ Self-contained

**Cons:**
- ❌ Large binary (+50MB)
- ❌ Complex implementation
- ❌ Go↔JS overhead
- ❌ No Windows support

**Use when:**
- Need advanced SDK features
- Can't require CLI installation
- Want latest SDK features
- Linux/macOS only

## Code Flow

### Upload Process

```
┌──────────┐
│   User   │
└────┬─────┘
     │ rclone copy file.txt my-storacha:
     ▼
┌─────────────┐
│ Fs.Put()    │ (Go)
└──────┬──────┘
       │ io.ReadAll(file)
       ▼
┌─────────────┐
│ JSON encode │
└──────┬──────┘
       │
       ▼
┌──────────────────┐
│ callAsyncJS()    │
└──────┬───────────┘
       │ v8go bridge
       ▼
┌─────────────────────────┐
│ storachaBridge.         │ (JavaScript)
│ uploadFile()            │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│ @storacha/client        │
│ .uploadFile()           │
└──────┬──────────────────┘
       │ HTTP to Storacha
       ▼
┌─────────────────────────┐
│ Storacha Network        │
└──────┬──────────────────┘
       │ Returns CID
       ▼
┌─────────────────────────┐
│ Promise resolves        │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│ Return to Go            │
│ { success: true,        │
│   cid: "bafy..." }      │
└─────────────────────────┘
```

## JavaScript Bridge API

All functions in `bridge.js`:

```javascript
// Initialize client
storachaBridge.initClient({ spaceDID: "did:key:..." })

// Authentication
storachaBridge.login("email@example.com")
storachaBridge.whoami()

// Spaces
storachaBridge.listSpaces()

// Upload operations  
storachaBridge.uploadFile(data, filename)
storachaBridge.uploadDirectory([{name, data}])

// List & manage
storachaBridge.listUploads(cursor, size)
storachaBridge.removeUpload(cid)
```

## V8 Helper Functions

```go
// Execute async JavaScript
result, err := fs.callAsyncJS(`
    storachaBridge.uploadFile(data, filename)
`)

// Parse result
var uploadResult struct {
    Success bool   `json:"success"`
    CID     string `json:"cid"`
    Error   string `json:"error"`
}
json.Unmarshal([]byte(result), &uploadResult)
```

## Common Issues & Solutions

### Issue: "Module not found"
**Solution:** Run `npm install` in `backend/storacha/`

### Issue: "Bundle file not found"  
**Solution:** Run `npm run bundle`

### Issue: "Promise timeout"
**Solution:** 
- Check network connection
- Increase timeout in `v8_helpers.go`
- Check Storacha service status

### Issue: "Space not found"
**Solution:**
- Verify `space_did` is correct
- Ensure you have access to the space
- Run `storacha space ls` to list available spaces

### Issue: "Client not initialized"
**Solution:**
- Check V8 initialization didn't fail
- Look for errors in verbose mode: `rclone -vv`
- Verify bundle loaded correctly

## Performance Tips

1. **Reuse V8 Context:** The Fs struct maintains a single V8 context
2. **Minimize Go↔JS Calls:** Batch operations when possible
3. **Stream Large Files:** Use chunking for files >10MB
4. **Cache Results:** Cache space listings, etc.

## Memory Management

```go
// V8 resources are cleaned up
func (f *Fs) Shutdown(ctx context.Context) error {
    f.mu.Lock()
    defer f.mu.Unlock()
    
    if f.v8iso != nil {
        f.v8iso.Dispose() // ⚠️ Important!
        f.v8iso = nil
    }
    return nil
}
```

## Debugging

### Enable verbose logging
```bash
rclone -vv copy file.txt my-storacha:
```

### Check bundle contents
```bash
head -n 50 backend/storacha/storacha-bundle-combined.js
```

### Test JavaScript directly
```javascript
// In Node.js
const Client = require('@storacha/client');
const client = await Client.create();
console.log(client);
```

### V8 debugging
```go
// Add debug logging in v8_helpers.go
fmt.Printf("Executing JS: %s\n", script)
```

## Migrating from CLI to SDK

### Before (CLI)
```go
cmd := exec.CommandContext(ctx, "storacha", "upload", "--space", did, file)
out, err := cmd.CombinedOutput()
```

### After (SDK)
```go
result, err := f.callAsyncJS(fmt.Sprintf(`
    storachaBridge.uploadFile(%s, %s)
`, dataJSON, filenameJSON))
```

## Binary Size Comparison

| Implementation | Binary Size | Notes |
|----------------|-------------|-------|
| CLI-based | +0MB | Requires external CLI |
| SDK-based | +50-55MB | Self-contained |

## Platform Support

| Platform | CLI | SDK |
|----------|-----|-----|
| Linux x64 | ✅ | ✅ |
| Linux ARM64 | ✅ | ✅ |
| macOS x64 | ✅ | ✅ |
| macOS ARM64 | ✅ | ✅ |
| Windows | ✅ | ❌ |

## Next Steps

1. ✅ Set up development environment
2. ✅ Bundle JavaScript SDK
3. ⬜ Test with real Storacha account
4. ⬜ Implement remaining features
5. ⬜ Add comprehensive tests
6. ⬜ Optimize performance
7. ⬜ Write user documentation

## Resources

- 📚 [Complete Setup Guide](SETUP_GUIDE.md)
- 🔧 [v8go Documentation](https://pkg.go.dev/rogchap.com/v8go)
- 📖 [Storacha Docs](https://storacha.network/docs)
- 🐛 [Report Issues](https://github.com/rclone/rclone/issues)
