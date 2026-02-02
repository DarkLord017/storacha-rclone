# Storacha Backend - TODO List

## 🔴 Critical (Must Do)

- [ ] **Test with real Storacha account**
  - Create Storacha account
  - Configure space
  - Test upload flow
  - Verify CID generation
  
- [ ] **Create storacha-bundle-combined.js**
  - Currently the bundle doesn't exist
  - Need to run `npm install && npm run bundle`
  - This file is embedded via `//go:embed`
  
- [ ] **Fix async/await handling in v8go**
  - Current promise polling is naive
  - Need better async resolution
  - Consider v8go's async patterns

- [ ] **Error handling improvements**
  - Better error messages from JS
  - Wrap errors with context
  - Add error recovery

## 🟡 High Priority (Should Do)

- [ ] **Implement download functionality**
  - Add IPFS gateway integration
  - HTTP fetch from storacha.link
  - Stream response back to Go
  - Handle large files efficiently
  
- [ ] **Add progress tracking**
  - Upload progress callbacks
  - Chunk upload reporting  
  - Integration with rclone's progress system
  
- [ ] **Streaming uploads**
  - Don't load entire file in memory
  - Implement chunked reading
  - CAR file generation
  - Shard callbacks
  
- [ ] **Authentication improvements**
  - Better login flow
  - Token persistence
  - Delegation proof support
  - Auto-refresh tokens

## 🟢 Medium Priority (Nice to Have)

- [ ] **Unit tests**
  - Test V8 helpers
  - Test JavaScript bridge
  - Mock SDK responses
  - Test error cases
  
- [ ] **Integration tests**
  - Test with mock Storacha service
  - Test full upload/download cycle
  - Test error scenarios
  - Performance benchmarks
  
- [ ] **Performance optimization**
  - Reduce JSON serialization
  - Cache V8 contexts
  - Batch operations
  - Connection pooling
  
- [ ] **Better async handling**
  - Use V8 microtask queue
  - Event loop integration
  - Proper promise chains
  - Timeout improvements

## 🔵 Low Priority (Future)

- [ ] **Concurrent uploads**
  - Multiple V8 isolates
  - Worker thread support
  - Upload queue
  - Rate limiting
  
- [ ] **Advanced features**
  - CAR file support
  - Custom CID versions
  - Pin management
  - Space administration
  
- [ ] **Windows support**
  - Wait for v8go Windows build
  - Or find alternative (goja, WebAssembly)
  - Test on Windows when available
  
- [ ] **WebAssembly alternative**
  - Compile SDK to WASM
  - Use wasmer-go or wasmtime-go
  - Compare performance vs v8go
  - Smaller binary size?

## 📚 Documentation

- [x] SETUP_GUIDE.md
- [x] QUICKREF.md  
- [x] IMPLEMENTATION_SUMMARY.md
- [ ] API documentation (godoc comments)
- [ ] User guide for rclone.org
- [ ] Video tutorial
- [ ] Troubleshooting guide expansion
- [ ] Performance tuning guide

## 🧪 Testing Checklist

- [ ] **Setup tests**
  - [ ] npm install works
  - [ ] Bundle creation works
  - [ ] Go build works
  - [ ] V8 loads bundle
  
- [ ] **Functional tests**
  - [ ] Client initialization
  - [ ] Authentication
  - [ ] Space selection
  - [ ] File upload
  - [ ] Directory upload
  - [ ] List uploads
  - [ ] Remove upload
  
- [ ] **Error tests**
  - [ ] Invalid space DID
  - [ ] Network failure
  - [ ] Auth failure
  - [ ] Large file handling
  - [ ] Concurrent operations

## 🐛 Known Issues

1. **Bundle file missing**
   - Status: Must fix
   - Solution: Run `npm run bundle`
   
2. **Promise polling inefficient**
   - Status: Works but suboptimal
   - Solution: Use better async primitives
   
3. **No download support**
   - Status: Not implemented
   - Solution: Add IPFS gateway integration
   
4. **Memory usage for large files**
   - Status: Loads all in memory
   - Solution: Implement streaming
   
5. **Windows not supported**
   - Status: v8go limitation
   - Solution: Wait for v8go or use alternative

## 🔧 Build Issues to Fix

- [ ] Ensure bundle is created before Go build
- [ ] Add build tags for optional v8go support
- [ ] Cross-compilation testing
- [ ] Binary size optimization
- [ ] Strip debug symbols option

## 📊 Metrics to Track

- [ ] Bundle size (current: unknown, need to build)
- [ ] Binary size increase (~50-55MB expected)
- [ ] Upload performance (vs CLI)
- [ ] Memory usage
- [ ] CPU usage
- [ ] Go↔JS call overhead

## 🚀 Deployment

- [ ] Add to rclone backend registry
- [ ] Update rclone documentation
- [ ] Add to rclone.org backend list
- [ ] CI/CD integration
- [ ] Release notes
- [ ] Announce to community

## 🎯 Next Immediate Steps

1. **Install npm packages**
   ```bash
   cd backend/storacha
   npm install
   ```

2. **Create bundle**
   ```bash
   npm run bundle
   ```

3. **Verify bundle exists**
   ```bash
   ls -lh storacha-bundle-combined.js
   ```

4. **Try building Go**
   ```bash
   cd ../..
   go build ./backend/storacha/...
   ```

5. **Test basic functionality**
   - Create test file
   - Configure remote
   - Try upload

## 💡 Ideas for Future

- [ ] Storacha CLI compatibility mode
- [ ] Hybrid approach (try SDK, fallback to CLI)
- [ ] Pure Go implementation of Storacha protocol
- [ ] IPFS native integration
- [ ] Filecoin integration
- [ ] w3up protocol support
- [ ] Custom storage deals
- [ ] Analytics and reporting
- [ ] Cost optimization

## 🤝 Community

- [ ] Announce on rclone forum
- [ ] Share on Storacha Discord
- [ ] Blog post about implementation
- [ ] Example use cases
- [ ] Tutorial videos

## 📝 Notes

- Binary will be ~50MB larger due to V8
- Bundle needs to be created before build
- Currently only works on Linux/macOS
- Need real Storacha account to test
- Consider memory usage for large files

---

**Last Updated**: February 3, 2026  
**Status**: Initial implementation complete, needs testing
**Priority**: Get bundle working, then test with real account
