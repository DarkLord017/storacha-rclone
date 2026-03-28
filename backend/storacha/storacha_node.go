// Package storacha provides a Storacha backend for rclone using Node.js subprocess
package storacha

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/hash"
)

// Fs represents a Storacha filesystem backed by Node.js subprocess
type Fs struct {
	name        string
	remoteRoot  string
	rootCID     string
	spaceDID    string
	email       string
	privateKey  string
	proofPath   string
	node        *NodeBridge
	fileCIDMap  map[string]string // Maps file path → root CID for tracking
	fileCIDLock sync.RWMutex      // Protects fileCIDMap
	rootMu      sync.Mutex        // Serializes root-modifying operations (Put, Mkdir, Remove)
}

// Object represents a file stored in Storacha
type Object struct {
	fs      *Fs
	remote  string
	cid     string
	size    int64
	modTime time.Time
}

// NodeBridge manages communication with Node.js process
type NodeBridge struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	mu     sync.Mutex
}

// JSRequest is a request to the Node.js process
type JSRequest struct {
	ID     int         `json:"id"`
	Method string      `json:"method"`
	Params interface{} `json:"params"`
}

// JSResponse is a response from the Node.js process
type JSResponse struct {
	ID      int             `json:"id"`
	Success bool            `json:"success"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
}

// ------------------------------------------------------------
// Backend registration
// ------------------------------------------------------------

func init() {
	fs.Register(&fs.RegInfo{
		Name:        "storacha",
		Description: "Storacha Decentralized Storage",
		NewFs:       NewFs,
		Options: []fs.Option{
			{
				Name:     "space_did",
				Help:     "Storacha space DID to operate on.",
				Required: true,
			},
			{
				Name:     "email",
				Help:     "Email for Storacha authentication (used when private_key is not set).",
				Required: false,
			},
			{
				Name:     "private_key",
				Help:     "Ed25519 private key for UCAN key-based authentication (base64 encoded, starts with Mg...).",
				Required: false,
			},
			{
				Name:     "proof_path",
				Help:     "Path to proof.ucan delegation file for UCAN key-based authentication.",
				Required: false,
			},
		},
	})
}

// ------------------------------------------------------------
// Node.js Bridge
// ------------------------------------------------------------

func findNodeScript() (string, error) {
	// Look for the Node.js bridge script
	// Check in the same directory as the executable first
	execPath, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(execPath)
		scriptPath := filepath.Join(dir, "storacha-bridge.mjs")
		if _, err := os.Stat(scriptPath); err == nil {
			return scriptPath, nil
		}
	}

	// Check common locations
	locations := []string{
		"./storacha-bridge.mjs",
		"./backend/storacha/storacha-bridge.mjs",
		"/usr/local/share/rclone/storacha-bridge.mjs",
	}

	for _, loc := range locations {
		if _, err := os.Stat(loc); err == nil {
			abs, _ := filepath.Abs(loc)
			return abs, nil
		}
	}

	return "", fmt.Errorf("storacha-bridge.mjs not found")
}

func NewNodeBridge(ctx context.Context) (*NodeBridge, error) {
	// Check if Node.js is available
	nodePath, err := exec.LookPath("node")
	if err != nil {
		return nil, fmt.Errorf("Node.js not found. Please install Node.js 18+: %w", err)
	}

	scriptPath, err := findNodeScript()
	if err != nil {
		return nil, err
	}

	cmd := exec.CommandContext(ctx, nodePath, scriptPath)
	cmd.Stderr = os.Stderr // Forward Node.js errors

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start Node.js: %w", err)
	}

	return &NodeBridge{
		cmd:    cmd,
		stdin:  stdin,
		stdout: bufio.NewReader(stdout),
	}, nil
}

func (n *NodeBridge) Call(method string, params interface{}) (*JSResponse, error) {
	n.mu.Lock()
	defer n.mu.Unlock()

	req := JSRequest{
		ID:     1,
		Method: method,
		Params: params,
	}

	// Send request
	reqJSON, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	if _, err := fmt.Fprintf(n.stdin, "%s\n", reqJSON); err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}

	// Read response
	line, err := n.stdout.ReadString('\n')
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var resp JSResponse
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return &resp, nil
}

func (n *NodeBridge) Close() error {
	n.stdin.Close()
	return n.cmd.Wait()
}

// ------------------------------------------------------------
// Fs construction & initialization
// ------------------------------------------------------------

func NewFs(ctx context.Context, name, root string, m configmap.Mapper) (fs.Fs, error) {
	spaceDID, _ := m.Get("space_did")
	email, _ := m.Get("email")
	privateKey, _ := m.Get("private_key")
	proofPath, _ := m.Get("proof_path")

	if spaceDID == "" {
		return nil, fmt.Errorf("storacha: space_did is required")
	}

	// Start Node.js bridge
	node, err := NewNodeBridge(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to start Node.js bridge: %w", err)
	}

	f := &Fs{
		name:       name,
		remoteRoot: path.Clean(root),
		rootCID:    "",
		spaceDID:   spaceDID,
		email:      email,
		privateKey: privateKey,
		proofPath:  proofPath,
		node:       node,
		fileCIDMap: make(map[string]string),
	}

	// Build init params based on auth mode
	initParams := map[string]string{
		"spaceDID": spaceDID,
	}

	if privateKey != "" && proofPath != "" {
		// UCAN key-based authentication
		absProofPath, err := filepath.Abs(proofPath)
		if err != nil {
			node.Close()
			return nil, fmt.Errorf("failed to resolve proof path: %w", err)
		}
		if _, err := os.Stat(absProofPath); err != nil {
			node.Close()
			return nil, fmt.Errorf("proof file not found at %s: %w", absProofPath, err)
		}
		initParams["privateKey"] = privateKey
		initParams["proofPath"] = absProofPath
		fs.Logf(f, "Using UCAN key-based authentication")
	} else if email != "" {
		initParams["email"] = email
		fs.Logf(f, "Using email-based authentication")
	}

	// Initialize the client
	resp, err := node.Call("init", initParams)
	if err != nil {
		node.Close()
		return nil, fmt.Errorf("failed to initialize: %w", err)
	}

	if !resp.Success {
		node.Close()
		return nil, fmt.Errorf("initialization failed: %s", resp.Error)
	}

	// Fetch the root CID — empty string is valid (no uploads yet)
	if err := f.refreshRootCID(); err != nil {
		node.Close()
		return nil, err
	}

	return f, nil
}

func (f *Fs) refreshRootCID() error {
	resp, err := f.node.Call("getRootCID", map[string]interface{}{})
	if err != nil {
		return fmt.Errorf("failed to get root CID: %w", err)
	}
	if !resp.Success {
		return fmt.Errorf("failed to get root CID: %s", resp.Error)
	}
	var result struct {
		RootCID string `json:"rootCID"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return fmt.Errorf("failed to parse root CID: %w", err)
	}
	// Allow empty rootCID — means the space has no uploads yet
	f.rootCID = result.RootCID
	return nil
}

// recordFileCID records the mapping from file path to root CID
func (f *Fs) recordFileCID(filePath, cid string) {
	f.fileCIDLock.Lock()
	defer f.fileCIDLock.Unlock()
	if cid != "" {
		f.fileCIDMap[filePath] = cid
	}
}

// GetFileCIDMapping returns a copy of the file-to-CID mapping for inspection
func (f *Fs) GetFileCIDMapping() map[string]string {
	f.fileCIDLock.RLock()
	defer f.fileCIDLock.RUnlock()
	mapping := make(map[string]string)
	for k, v := range f.fileCIDMap {
		mapping[k] = v
	}
	return mapping
}

// ------------------------------------------------------------
// Fs interface
// ------------------------------------------------------------

func (f *Fs) Name() string   { return f.name }
func (f *Fs) Root() string   { return f.remoteRoot }
func (f *Fs) String() string { return "storacha:" + f.spaceDID }

func (f *Fs) Features() *fs.Features {
	return (&fs.Features{
		CanHaveEmptyDirectories: true,
		Copy:                    f.Copy,
	}).Fill(context.Background(), f)
}

// Copy src to this remote using server-side copy operations
func (f *Fs) Copy(ctx context.Context, src fs.Object, remote string) (fs.Object, error) {
	srcObj, ok := src.(*Object)
	if !ok {
		return nil, fs.ErrorCantCopy
	}

	resp, err := f.node.Call("copy", map[string]interface{}{
		"cid":    srcObj.cid,
		"remote": remote,
		"size":   srcObj.size,
	})
	if err != nil {
		return nil, fmt.Errorf("copy failed: %w", err)
	}

	if !resp.Success {
		return nil, fmt.Errorf("copy failed: %s", resp.Error)
	}

	var result struct {
		CID string `json:"cid"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return nil, fmt.Errorf("failed to parse copy result: %w", err)
	}

	return &Object{
		fs:      f,
		remote:  remote,
		cid:     result.CID,
		size:    srcObj.size,
		modTime: srcObj.modTime,
	}, nil
}

func (f *Fs) Precision() time.Duration {
	return time.Second
}

func (f *Fs) Hashes() hash.Set {
	return hash.Set(hash.None)
}

func (f *Fs) Shutdown(ctx context.Context) error {
	if f.node != nil {
		return f.node.Close()
	}
	return nil
}

// List the objects and directories in dir into entries
func (f *Fs) List(ctx context.Context, dir string) (entries fs.DirEntries, err error) {
	if f.rootCID == "" {
		// No uploads yet — return empty list
		return entries, nil
	}

	// Combine root and dir to get the full path
	fullPath := dir
	if dir != "" {
		fullPath = f.rootCID + "/" + dir
	} else {
		fullPath = f.rootCID
	}

	fs.Debugf(f, "List dir=%q fullPath=%q", dir, fullPath)

	resp, err := f.node.Call("list", map[string]string{
		"path": fullPath,
	})
	if err != nil {
		return nil, err
	}

	if !resp.Success {
		// Check if it's a "not a directory" error
		if resp.Error != "" && (len(resp.Error) > 15 && resp.Error[:15] == "Not a directory") {
			return nil, fs.ErrorIsFile
		}
		if resp.Error != "" && (len(resp.Error) > 18 && resp.Error[:18] == "Directory not found") {
			return nil, fs.ErrorDirNotFound
		}
		return nil, fmt.Errorf("list failed: %s", resp.Error)
	}

	var items []struct {
		Name    string `json:"name"`
		Size    int64  `json:"size"`
		IsDir   bool   `json:"isDir"`
		ModTime string `json:"modTime"`
		CID     string `json:"cid"`
	}

	if err := json.Unmarshal(resp.Result, &items); err != nil {
		return nil, fmt.Errorf("failed to parse list result: %w", err)
	}

	for _, item := range items {
		remote := item.Name
		if dir != "" {
			remote = dir + "/" + item.Name
		}

		if item.IsDir {
			modTime, _ := time.Parse(time.RFC3339, item.ModTime)
			entries = append(entries, fs.NewDir(remote, modTime))
		} else {
			modTime, _ := time.Parse(time.RFC3339, item.ModTime)
			entries = append(entries, &Object{
				fs:      f,
				remote:  remote,
				cid:     item.CID,
				size:    item.Size,
				modTime: modTime,
			})
		}
	}

	fs.Debugf(f, "List found %d entries", len(entries))
	return entries, nil
}

// NewObject finds an object by remote path
func (f *Fs) NewObject(ctx context.Context, remote string) (fs.Object, error) {
	if f.rootCID == "" {
		return nil, fs.ErrorObjectNotFound
	}

	// Build the stat path as rootCID/remote
	fullPath := f.rootCID + "/" + remote

	// Query the bridge for file info
	resp, err := f.node.Call("stat", map[string]string{
		"name": fullPath,
	})
	if err != nil {
		return nil, err
	}

	if !resp.Success {
		return nil, fmt.Errorf("stat failed: %s", resp.Error)
	}

	var result struct {
		Found   bool   `json:"found"`
		CID     string `json:"cid"`
		Size    int64  `json:"size"`
		IsDir   bool   `json:"isDir"`
		ModTime string `json:"modTime"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return nil, fmt.Errorf("failed to parse stat result: %w", err)
	}

	if !result.Found {
		return nil, fs.ErrorObjectNotFound
	}

	// If remote points to a directory, return ErrorIsDir
	if result.IsDir {
		fs.Debugf(f, "NewObject: %q is a directory", remote)
		return nil, fs.ErrorIsDir
	}

	modTime, _ := time.Parse(time.RFC3339, result.ModTime)
	return &Object{
		fs:      f,
		remote:  remote,
		cid:     result.CID,
		size:    result.Size,
		modTime: modTime,
	}, nil
}

// Put uploads a file into the DAG tree and updates the root CID.
func (f *Fs) Put(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) (fs.Object, error) {
	// stream to temp file instead of buffering entire file in memory
	// this decreases memory usage in loading into head, encoding, pipe write and then node also holds it in memory
	tmpFile, err := os.CreateTemp("", "rclone-storacha-upload-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath)

	written, err := io.Copy(tmpFile, in)
	if err != nil {
		tmpFile.Close()
		return nil, fmt.Errorf("failed to write temp file: %w", err)
	}
	tmpFile.Close()

	fs.Logf(f, "Streaming upload: %s (%d bytes via temp file)", src.Remote(), written)

	// Serialise all root-modifying operations so concurrent transfers don't
	// clobber each other's rootCID updates.
	f.rootMu.Lock()
	defer f.rootMu.Unlock()

	resp, err := f.node.Call("upload", map[string]interface{}{
		"name":     src.Remote(),
		"filePath": tmpPath,
		"size":     written,
		"rootCID":  f.rootCID, // current root; bridge creates a fresh one if empty
	})
	if err != nil {
		return nil, fmt.Errorf("upload failed: %w", err)
	}

	if !resp.Success {
		return nil, fmt.Errorf("upload failed: %s", resp.Error)
	}

	var result struct {
		CID        string `json:"cid"`
		NewRootCID string `json:"newRootCID"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return nil, fmt.Errorf("failed to parse upload result: %w", err)
	}

	// Update the root CID so subsequent operations see the new tree.
	if result.NewRootCID != "" {
		f.rootCID = result.NewRootCID
		f.recordFileCID(src.Remote(), result.NewRootCID)
	}
	fs.Logf(f, "Uploaded %s -> CID: %s", src.Remote(), result.CID)

	return &Object{
		fs:      f,
		remote:  src.Remote(),
		cid:     result.CID,
		size:    src.Size(),
		modTime: src.ModTime(ctx),
	}, nil
}

// Mkdir creates a directory in the DAG tree.
func (f *Fs) Mkdir(ctx context.Context, dir string) error {
	// Root always exists.
	if dir == "" {
		return nil
	}

	f.rootMu.Lock()
	defer f.rootMu.Unlock()

	parent := path.Dir(dir)
	if parent == "." {
		parent = ""
	}
	name := path.Base(dir)

	// Pass f.rootCID even if empty — the bridge will create a fresh root.
	resp, err := f.node.Call("mkdir", map[string]interface{}{
		"cid":  f.rootCID,
		"path": parent,
		"name": name,
	})
	if err != nil {
		return fmt.Errorf("mkdir failed: %w", err)
	}

	if !resp.Success {
		return fmt.Errorf("mkdir failed: %s", resp.Error)
	}
	var result struct {
		NewRootCID string `json:"newRootCID"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return fmt.Errorf("mkdir failed to parse new root CID: %w", err)
	}
	if result.NewRootCID == "" {
		return fmt.Errorf("mkdir failed: missing newRootCID")
	}
	f.rootCID = result.NewRootCID
	f.recordFileCID(dir, result.NewRootCID)
	return nil
}
func (f *Fs) Rmdir(ctx context.Context, dir string) error {
	if dir == "" {
		// Root: report not-empty if any files exist, not-found if truly empty.
		if f.rootCID == "" {
			return fs.ErrorDirNotFound
		}
		entries, err := f.List(context.Background(), "")
		if err != nil {
			return err
		}
		if len(entries) == 0 {
			return fs.ErrorDirNotFound
		}
		return fs.ErrorDirectoryNotEmpty
	}

	f.rootMu.Lock()
	defer f.rootMu.Unlock()

	if f.rootCID == "" {
		return fs.ErrorDirNotFound
	}

	parent := path.Dir(dir)
	if parent == "." {
		parent = ""
	}
	name := path.Base(dir)

	resp, err := f.node.Call("rmdir", map[string]interface{}{
		"cid":  f.rootCID,
		"path": parent,
		"name": name,
	})
	if err != nil {
		return fmt.Errorf("rmdir failed: %w", err)
	}

	if !resp.Success {
		return fmt.Errorf("rmdir failed: %s", resp.Error)
	}
	var result struct {
		NewRootCID string `json:"newRootCID"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return fmt.Errorf("rmdir failed to parse new root CID: %w", err)
	}
	if result.NewRootCID == "" {
		return fmt.Errorf("rmdir failed: missing newRootCID")
	}
	f.rootCID = result.NewRootCID
	f.recordFileCID(dir, result.NewRootCID)

	return nil
}

// ------------------------------------------------------------
// Object methods
// ------------------------------------------------------------

func (o *Object) Fs() fs.Info                           { return o.fs }
func (o *Object) String() string                        { return o.remote }
func (o *Object) Remote() string                        { return o.remote }
func (o *Object) Size() int64                           { return o.size }
func (o *Object) ModTime(ctx context.Context) time.Time { return o.modTime }
func (o *Object) Storable() bool                        { return true }

func (o *Object) Hash(ctx context.Context, ty hash.Type) (string, error) {
	return "", hash.ErrUnsupported
}

func (o *Object) SetModTime(ctx context.Context, t time.Time) error {
	return fs.ErrorNotImplemented
}

func (o *Object) Open(ctx context.Context, options ...fs.OpenOption) (io.ReadCloser, error) {
	if o.cid == "" {
		return nil, fmt.Errorf("cannot open object without CID")
	}

	resp, err := o.fs.node.Call("download", map[string]string{
		"cid": o.cid,
	})
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}

	if !resp.Success {
		return nil, fmt.Errorf("download failed: %s", resp.Error)
	}

	var result struct {
		Data []byte `json:"data"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return nil, fmt.Errorf("failed to parse download result: %w", err)
	}

	return io.NopCloser(io.NewSectionReader(
		&byteReader{data: result.Data}, 0, int64(len(result.Data)),
	)), nil
}

type byteReader struct {
	data []byte
}

func (b *byteReader) ReadAt(p []byte, off int64) (n int, err error) {
	if off >= int64(len(b.data)) {
		return 0, io.EOF
	}
	n = copy(p, b.data[off:])
	return n, nil
}

func (o *Object) Update(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) error {
	_, err := o.fs.Put(ctx, in, src, options...)
	return err
}

func (o *Object) Remove(ctx context.Context) error {
	if o.fs.rootCID == "" {
		return fmt.Errorf("cannot remove: root not initialised")
	}

	parent := path.Dir(o.remote)
	if parent == "." {
		parent = ""
	}
	name := path.Base(o.remote)

	o.fs.rootMu.Lock()
	defer o.fs.rootMu.Unlock()

	resp, err := o.fs.node.Call("remove", map[string]interface{}{
		"rootCID": o.fs.rootCID,
		"path":    parent,
		"name":    name,
	})
	if err != nil {
		return fmt.Errorf("remove failed: %w", err)
	}

	if !resp.Success {
		return fmt.Errorf("remove failed: %s", resp.Error)
	}

	var result struct {
		NewRootCID string `json:"newRootCID"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return fmt.Errorf("failed to parse remove result: %w", err)
	}
	if result.NewRootCID != "" {
		o.fs.rootCID = result.NewRootCID
	}

	return nil
}

// ------------------------------------------------------------
// Interface checks
// ------------------------------------------------------------

var (
	_ fs.Fs         = (*Fs)(nil)
	_ fs.Shutdowner = (*Fs)(nil)
	_ fs.Object     = (*Object)(nil)
)
