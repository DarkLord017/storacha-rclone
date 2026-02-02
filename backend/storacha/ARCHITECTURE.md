# Storacha Backend Architecture

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         rclone User                              │
│                                                                  │
│  $ rclone copy myfile.txt my-storacha:uploads/                 │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    rclone Core (Go)                              │
│                                                                  │
│  • Command parsing                                               │
│  • File I/O                                                      │
│  • Progress tracking                                             │
│  • Error handling                                                │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              Storacha Backend (storacha_v8.go)                   │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   Fs struct  │    │    Object    │    │  V8Helper    │      │
│  │              │    │    struct    │    │              │      │
│  │ • V8 context │    │ • CID        │    │ • Async exec │      │
│  │ • Space DID  │    │ • Metadata   │    │ • Promise    │      │
│  │ • Config     │    │ • Size       │    │   handling   │      │
│  └──────┬───────┘    └──────────────┘    └──────┬───────┘      │
│         │                                         │              │
│         └─────────────────┬───────────────────────┘              │
│                           │                                      │
│                           ▼                                      │
│                  callAsyncJS(script)                             │
│                           │                                      │
└───────────────────────────┼──────────────────────────────────────┘
                            │
                            │ v8go C bindings
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    V8 JavaScript Engine                          │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │               V8 Isolate (Isolated Context)                │ │
│  │                                                            │ │
│  │  ┌──────────────────────────────────────────────────────┐ │ │
│  │  │           storacha-bundle-combined.js                │ │ │
│  │  │                                                      │ │ │
│  │  │  ┌────────────────────┐  ┌───────────────────────┐ │ │ │
│  │  │  │  @storacha/client  │  │     bridge.js         │ │ │ │
│  │  │  │                    │  │                       │ │ │ │
│  │  │  │ • create()         │  │ • initClient()        │ │ │ │
│  │  │  │ • login()          │  │ • uploadFile()        │ │ │ │
│  │  │  │ • uploadFile()     │  │ • uploadDirectory()   │ │ │ │
│  │  │  │ • uploadDirectory()│  │ • listUploads()       │ │ │ │
│  │  │  │ • spaces()         │  │ • removeUpload()      │ │ │ │
│  │  │  │ • remove()         │  │ • Error handling      │ │ │ │
│  │  │  └────────────────────┘  └───────────────────────┘ │ │ │
│  │  │                                                      │ │ │
│  │  └──────────────────────────────────────────────────────┘ │ │
│  │                                                            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            │ HTTP/HTTPS
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Storacha Network                              │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   API Server │    │  IPFS Nodes  │    │   Filecoin   │      │
│  │              │    │              │    │   Storage    │      │
│  │ • Auth       │───▶│ • Store data │───▶│              │      │
│  │ • Upload     │    │ • Generate   │    │ • Long-term  │      │
│  │ • Metadata   │    │   CID        │    │   storage    │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow: Upload Operation

```
┌─────────────┐
│    User     │
└──────┬──────┘
       │ rclone copy file.txt my-storacha:
       ▼
┌─────────────────┐
│ rclone/cmd      │  Parse command
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ fs.Put()        │  Read file from disk
│ (storacha_v8)   │
└──────┬──────────┘
       │ io.ReadAll(file)
       ▼
┌─────────────────┐
│ []byte data     │  File content in memory
└──────┬──────────┘
       │ json.Marshal(data)
       ▼
┌─────────────────┐
│ JSON string     │  "[65, 66, 67, ...]"
└──────┬──────────┘
       │
       ▼
┌──────────────────────────────┐
│ callAsyncJS(                 │
│   "storachaBridge            │
│    .uploadFile(data, name)"  │
│ )                            │
└──────┬───────────────────────┘
       │ v8go bridge
       ▼
┌─────────────────┐
│ V8 executes:    │
│ - Parse args    │
│ - Call bridge   │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ bridge.js       │
│ uploadFile()    │
└──────┬──────────┘
       │ new Blob([data])
       │ new File([blob], name)
       ▼
┌─────────────────┐
│ @storacha/      │
│ client          │
│ .uploadFile()   │
└──────┬──────────┘
       │ HTTP POST to Storacha
       ▼
┌─────────────────┐
│ Storacha        │
│ Network         │
│ - Stores file   │
│ - Generates CID │
│ - Returns CID   │
└──────┬──────────┘
       │ { success: true, cid: "bafy..." }
       ▼
┌─────────────────┐
│ Promise         │
│ resolves        │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ V8 promise      │
│ .then()         │
└──────┬──────────┘
       │ WaitForPromise()
       ▼
┌─────────────────┐
│ JSON.stringify  │
│ (result)        │
└──────┬──────────┘
       │ '{"success":true,"cid":"bafy..."}'
       ▼
┌─────────────────┐
│ Return to Go    │
└──────┬──────────┘
       │ json.Unmarshal()
       ▼
┌─────────────────┐
│ uploadResult    │
│ struct          │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ Create Object   │
│ with CID        │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ Return to       │
│ rclone core     │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ Success!        │
│ File uploaded   │
└─────────────────┘
```

## Component Interaction

```
┌────────────────────────────────────────────────────────┐
│                    Build Time                          │
├────────────────────────────────────────────────────────┤
│                                                        │
│  npm install                                           │
│     │                                                  │
│     ▼                                                  │
│  @storacha/client downloaded                          │
│     │                                                  │
│     ▼                                                  │
│  npm run bundle (esbuild)                             │
│     │                                                  │
│     ▼                                                  │
│  storacha-bundle-combined.js created                  │
│     │                                                  │
│     ▼                                                  │
│  go build                                              │
│     │                                                  │
│     ▼                                                  │
│  //go:embed bundles JS into binary                    │
│     │                                                  │
│     ▼                                                  │
│  rclone binary (with embedded SDK)                     │
│                                                        │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                    Runtime                             │
├────────────────────────────────────────────────────────┤
│                                                        │
│  rclone config                                         │
│     │                                                  │
│     ▼                                                  │
│  NewFs() called                                        │
│     │                                                  │
│     ▼                                                  │
│  v8.NewIsolate() ──┐                                  │
│                    │                                   │
│  v8.NewContext() ──┤                                  │
│                    │  V8 initialization                │
│  loadSDK() ────────┤                                  │
│                    │  Load embedded JS                 │
│  initClient() ─────┘                                  │
│     │              Execute storachaBridge.initClient() │
│     ▼                                                  │
│  Ready to use                                          │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │              Operations Loop                     │ │
│  │                                                  │ │
│  │  User operation (copy, ls, rm, etc.)            │ │
│  │     │                                            │ │
│  │     ▼                                            │ │
│  │  Go function (Put, List, Remove)                │ │
│  │     │                                            │ │
│  │     ▼                                            │ │
│  │  callAsyncJS()                                   │ │
│  │     │                                            │ │
│  │     ▼                                            │ │
│  │  V8 executes JavaScript                          │ │
│  │     │                                            │ │
│  │     ▼                                            │ │
│  │  bridge.js calls SDK                             │ │
│  │     │                                            │ │
│  │     ▼                                            │ │
│  │  HTTP to Storacha                                │ │
│  │     │                                            │ │
│  │     ▼                                            │ │
│  │  Promise resolves                                │ │
│  │     │                                            │ │
│  │     ▼                                            │ │
│  │  Return to Go                                    │ │
│  │     │                                            │ │
│  │     ▼                                            │ │
│  │  Process result                                  │ │
│  │                                                  │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  On shutdown:                                          │
│     │                                                  │
│     ▼                                                  │
│  Shutdown() called                                     │
│     │                                                  │
│     ▼                                                  │
│  v8iso.Dispose()  ← Clean up V8 resources             │
│                                                        │
└────────────────────────────────────────────────────────┘
```

## File Dependencies

```
storacha_v8.go
   ├─ depends on ─► v8_helpers.go
   ├─ embeds ─────► storacha-bundle-combined.js
   └─ imports ────► rogchap.com/v8go

v8_helpers.go
   └─ imports ────► rogchap.com/v8go

storacha-bundle-combined.js
   ├─ contains ───► storacha-sdk-bundle.js
   └─ contains ───► bridge.js

storacha-sdk-bundle.js
   └─ bundles ────► @storacha/client + dependencies

bridge.js
   └─ wraps ──────► @storacha/client methods

bundle.js (build script)
   ├─ reads ──────► sdk-wrapper.js
   ├─ reads ──────► bridge.js
   └─ creates ────► storacha-bundle-combined.js

sdk-wrapper.js
   └─ exports ────► @storacha/client to global
```

## Memory Layout

```
┌─────────────────────────────────────────────────────────┐
│                    rclone Process                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │           Go Runtime Heap                       │   │
│  │                                                 │   │
│  │  • Fs struct                                    │   │
│  │  • Object structs                               │   │
│  │  • File buffers                                 │   │
│  │  • JSON serialization buffers                   │   │
│  │                                                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │           V8 Heap (per Isolate)                 │   │
│  │                                                 │   │
│  │  • JavaScript objects                           │   │
│  │  • Bundled SDK code                             │   │
│  │  • Promise chains                               │   │
│  │  • File Blob objects                            │   │
│  │  • SDK client state                             │   │
│  │  • Auth tokens                                  │   │
│  │                                                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │           v8go C Bindings                       │   │
│  │                                                 │   │
│  │  • V8 API shims                                 │   │
│  │  • Type conversions                             │   │
│  │  • Error handling                               │   │
│  │                                                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘

Typical memory usage:
  • Base rclone: ~30MB
  • V8 engine: ~50MB
  • Per-file buffer: filesize
  • JavaScript heap: ~10MB
  • Total: ~90MB + file buffers
```

## Thread Model

```
┌─────────────────────────────────────────────────┐
│             Main Go Goroutine                   │
│                                                 │
│  User initiates operation                       │
│  ┌─────────────────────────────────────────┐   │
│  │                                         │   │
│  │  Fs.Put() ◄─── Go code (multi-thread) ──┐  │
│  │    │                                     │  │
│  │    │ f.mu.Lock()                         │  │
│  │    ▼                                     │  │
│  │  callAsyncJS() ◄── Mutex protected      │  │
│  │    │                                     │  │
│  │    ▼                                     │  │
│  │  v8ctx.RunScript()                       │  │
│  │    │                                     │  │
│  │    ▼                                     │  │
│  │  V8 execution (SINGLE THREADED) ────────┘  │
│  │    │                                        │
│  │    ▼                                        │
│  │  Promise polling loop                      │
│  │    │                                        │
│  │    ▼                                        │
│  │  Result ready                               │
│  │    │                                        │
│  │    │ f.mu.Unlock()                          │
│  │    ▼                                        │
│  │  Return to Go                               │
│  │                                             │
│  └─────────────────────────────────────────────┘
│                                                 │
└─────────────────────────────────────────────────┘

⚠️  V8 is SINGLE THREADED - all access must be synchronized!
```

## Error Handling Flow

```
┌─────────────────────────────────────────────────┐
│               Error Sources                     │
└────┬────────────────────────────────────────────┘
     │
     ├─► Go errors
     │   • File I/O errors
     │   • JSON marshal/unmarshal
     │   • Network errors
     │
     ├─► V8 errors  
     │   • Script compilation
     │   • Runtime exceptions
     │   • Promise rejections
     │
     └─► JavaScript errors
         • SDK errors
         • Network errors
         • Auth failures
         │
         ▼
┌─────────────────────────────────────────────────┐
│            Error Handling                       │
├─────────────────────────────────────────────────┤
│                                                 │
│  JavaScript error:                              │
│    try/catch ─► JSON.stringify({               │
│                   success: false,               │
│                   error: err.message            │
│                 })                              │
│      │                                          │
│      ▼                                          │
│  Return to Go as string                         │
│      │                                          │
│      ▼                                          │
│  json.Unmarshal into JSResult                   │
│      │                                          │
│      ▼                                          │
│  Check result.Success                           │
│      │                                          │
│      ├─► false: return fmt.Errorf(result.Error)│
│      └─► true: proceed                          │
│                                                 │
└─────────────────────────────────────────────────┘
```
