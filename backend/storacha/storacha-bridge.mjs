#!/usr/bin/env node
// storacha-bridge.mjs - Node.js bridge for rclone Storacha backend
// This script runs as a subprocess and communicates via stdin/stdout JSON

import * as Client from '@storacha/client';
import * as readline from 'readline';
import * as dagPB from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { CarWriter } from '@ipld/car';
import * as Name from 'w3name';
import fs from 'fs';
import path from 'path';
import os from 'os';

let client = null;
let currentSpace = null;

// W3name registry to track IPNS names by CID
// Format: { "cid": { name: Name, ipnsName: string, keyFile: string } }
const nameRegistry = new Map();

// Directory to store w3name keys
const W3NAME_DIR = path.join(os.homedir(), '.storacha-rclone', 'w3name-keys');

// Ensure key storage directory exists
async function ensureKeyDir() {
  try {
    await fs.promises.mkdir(W3NAME_DIR, { recursive: true });
  } catch (error) {
    console.error(`[w3name] Warning: Could not create key directory: ${error.message}`);
  }
}

// Save a w3name key to disk
async function saveNameKey(cid, name) {
  try {
    await ensureKeyDir();
    const keyFile = path.join(W3NAME_DIR, `${cid}.key`);
    await fs.promises.writeFile(keyFile, name.key.bytes);
    console.error(`[w3name] Saved key for CID ${cid} to ${keyFile}`);
    return keyFile;
  } catch (error) {
    console.error(`[w3name] Error saving key: ${error.message}`);
    return null;
  }
}

// Load a w3name key from disk
async function loadNameKey(cid) {
  try {
    const keyFile = path.join(W3NAME_DIR, `${cid}.key`);
    const bytes = await fs.promises.readFile(keyFile);
    const name = await Name.from(bytes);
    console.error(`[w3name] Loaded key for CID ${cid} from ${keyFile}`);
    return { name, keyFile };
  } catch (error) {
    // Don't log error - it's normal for keys to not exist
    return null;
  }
}

// Load all existing keys on startup
async function loadAllKeys() {
  try {
    await ensureKeyDir();
    const files = await fs.promises.readdir(W3NAME_DIR);
    
    for (const file of files) {
      if (file.endsWith('.key')) {
        const cid = file.replace('.key', '');
        const result = await loadNameKey(cid);
        if (result) {
          nameRegistry.set(cid, {
            name: result.name,
            ipnsName: result.name.toString(),
            keyFile: result.keyFile
          });
        }
      }
    }
    if (nameRegistry.size > 0) {
      console.error(`[w3name] Loaded ${nameRegistry.size} keys from ${W3NAME_DIR}`);
    }
  } catch (error) {
    console.error(`[w3name] Error loading keys: ${error.message}`);
  }
}

// Read JSON requests from stdin, write JSON responses to stdout
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// Handler functions
export const handlers = {
  async init({ spaceDID, email }) {
    try {
      // Create client
      client = await Client.create();
      
      // Login if email provided and not already logged in
      if (email && typeof email === 'string' && email.trim() !== '') {
        const accounts = client.accounts();
        if (Object.keys(accounts).length === 0) {
          console.error(`[storacha] Logging in with email: ${email}`);
          await client.login(email);
          console.error('[storacha] Check your email to authorize this agent');
        }
      }
      
      currentSpace = await client.createSpace('rclone-space');
      const newSpaceDID = spaceDID;
      
      // Set it as the current space
      await client.setCurrentSpace(newSpaceDID);
      
      // Load existing w3name keys from disk
      await loadAllKeys();
      
      return { initialized: true, spaceDID: newSpaceDID };
    } catch (error) {
      throw new Error(`Init failed: ${error.message}`);
    }
  },
  
  async upload({ name, data, size }) {
    if (!client) throw new Error('Client not initialized');
    if (!currentSpace) throw new Error('No space selected');
    
    // data comes as base64 from Go's JSON encoding of []byte
    const buffer = Buffer.from(data, 'base64');
    const file = new File([buffer], name, { type: 'application/octet-stream' });
    
    const cid = await client.uploadFile(file);
    const cidStr = cid.toString();
    
    return { 
      cid: cidStr,
      size: buffer.length 
    };
  },
  
  async uploadDirectory({ files }) {
    if (!client) throw new Error('Client not initialized');
    if (!currentSpace) throw new Error('No space selected');
    
    const fileObjects = files.map(f => {
      const buffer = Buffer.from(f.data, 'base64');
      return new File([buffer], f.name, { type: 'application/octet-stream' });
    });
    
    const rootCid = await client.uploadDirectory(fileObjects);
    const cidStr = rootCid.toString();
    
    // Create new w3name for this CID and save it
    const name = await Name.create();
    const ipnsName = name.toString();
    const revision = await Name.v0(name, rootCid);
    await Name.publish(revision, name.key);
    
    // Save to registry and disk
    const keyFile = await saveNameKey(cidStr, name);
    nameRegistry.set(cidStr, {
      name: name,
      ipnsName: ipnsName,
      keyFile: keyFile
    });
    
    console.error(`[w3name] Created and published ${ipnsName} for CID ${cidStr}`);
    
    return { cid: cidStr, name: ipnsName };
  },
  
  async list({ path: dirPath }) {
    if (!client) throw new Error('Client not initialized');
    if (!currentSpace) throw new Error('No space selected');
    
    console.error(`[storacha] list called with path: "${dirPath}"`);
    
    try {
      // If path is empty, list all uploads at root level
      if (!dirPath || dirPath === '' || dirPath === '/') {
        return await handlers.listRootUploads();
      }
      
      // Otherwise, treat path as CID or CID/subpath and list directory contents
      return await handlers.listDirectory({ cid: dirPath });
    } catch (error) {
      console.error(`[storacha] List failed: ${error.message}`);
      throw error;
    }
  },

  async listRootUploads() {
    const entries = [];
    
    let cursor;
    do {
      const res = await client.capability.upload.list({ cursor });
      if (!res || !res.results) break;
      
      for (const upload of res.results) {
        const rootCID = upload.root.toString();
        const size = upload.shards?.reduce((sum, s) => sum + (s.size || 0), 0) || 0;
        
        entries.push({
          name: rootCID,
          cid: rootCID,
          size: size,
          isDir: false,
          modTime: upload.insertedAt || new Date().toISOString()
        });
      }
      
      cursor = res.cursor;
    } while (cursor);
    
    return entries;
  },

  async listDirectory({ cid }) {
    console.error(`[storacha] listDirectory called with CID: "${cid}"`);
    
    // Parse path - could be just CID or CID/subpath
    const parts = cid.split('/').filter(Boolean);
    const rootCID = parts[0];
    const subPath = parts.slice(1);
    
    console.error(`[storacha] Root CID: ${rootCID}, subPath: ${subPath.join('/')}`);
    
    // Fetch the root DAG node
    let currentNode;
    try {
      currentNode = await handlers.fetchDag(rootCID);
    } catch (error) {
      console.error(`[storacha] Failed to fetch root CID: ${error.message}`);
      throw new Error(`Directory not found: ${cid}`);
    }
    
    // Walk the subpath if provided
    for (const part of subPath) {
      const link = currentNode.Links.find(l => l.Name === part);
      if (!link) {
        throw new Error(`Path not found: ${part} in ${cid}`);
      }
      currentNode = await handlers.fetchDag(link.Hash.toString());
    }
    
    // Parse UnixFS data to check if it's a directory
    let unixfs;
    try {
      unixfs = UnixFS.unmarshal(currentNode.Data);
    } catch (error) {
      console.error(`[storacha] Failed to parse UnixFS: ${error.message}`);
      // If we can't parse UnixFS, but have links, treat as directory
      if (currentNode.Links.length > 0) {
        unixfs = { type: 'directory' };
      } else {
        throw new Error(`Not a directory: ${cid}`);
      }
    }
    
    if (unixfs.type !== 'directory') {
      throw new Error(`Not a directory: ${cid}`);
    }
    
    // List all links in the directory
    const entries = [];
    for (const link of currentNode.Links) {
      const linkCID = link.Hash.toString();
      
      // Fetch child node to determine if it's a file or directory
      let isDir = false;
      let size = link.Tsize || 0;
      
      try {
        const childNode = await handlers.fetchDag(linkCID);
        const childUnixFS = UnixFS.unmarshal(childNode.Data);
        isDir = childUnixFS.type === 'directory';
        
        // For files, get the actual data size (not Tsize which includes overhead)
        if (!isDir && childUnixFS.data) {
          size = childUnixFS.data.length;
        }
      } catch (error) {
        console.error(`[storacha] Warning: could not fetch child node ${linkCID}: ${error.message}`);
        // Assume it's a file if we can't determine
        isDir = false;
      }
      
      entries.push({
        name: link.Name,
        cid: linkCID,
        size: size,
        isDir: isDir,
        modTime: new Date().toISOString() // DAG nodes don't have timestamps
      });
    }
    
    return entries;
  },
  
  async stat({ name }) {
    if (!client) throw new Error('Client not initialized');
    
    console.error(`[storacha] stat called with name: "${name}"`);
    
    try {
      // Parse path - could be just CID or CID/subpath
      const parts = name.split('/').filter(Boolean);
      const rootCID = parts[0];
      const subPath = parts.slice(1);
      
      console.error(`[storacha] Root CID: ${rootCID}, subPath: ${subPath.join('/')}`);
      
      // First check if this root CID exists in uploads (for root-level files)
      if (subPath.length === 0) {
        const upload = await handlers.findUploadByCID(rootCID);
        if (upload) {
          return {
            found: true,
            name: rootCID,
            cid: rootCID,
            size: upload.size,
            isDir: false,
            modTime: upload.modTime
          };
        }
      }
      
      // Try to fetch as DAG and traverse path
      let currentNode;
      let currentCID = rootCID;
      
      try {
        currentNode = await handlers.fetchDag(rootCID);
      } catch (error) {
        console.error(`[storacha] Failed to fetch root CID: ${error.message}`);
        return { found: false };
      }
      
      // Walk the subpath
      for (const part of subPath) {
        const link = currentNode.Links.find(l => l.Name === part);
        if (!link) {
          console.error(`[storacha] Path part not found: ${part}`);
          return { found: false };
        }
        currentCID = link.Hash.toString();
        currentNode = await handlers.fetchDag(currentCID);
      }
      
      // Parse UnixFS to determine type and size
      let unixfs;
      try {
        unixfs = UnixFS.unmarshal(currentNode.Data);
      } catch (error) {
        console.error(`[storacha] Failed to parse UnixFS: ${error.message}`);
        // If we can't parse but have links, assume directory
        if (currentNode.Links.length > 0) {
          return {
            found: true,
            name: name,
            cid: currentCID,
            size: 0,
            isDir: true,
            modTime: new Date().toISOString()
          };
        }
        return { found: false };
      }
      
      const isDir = unixfs.type === 'directory';
      let size = 0;
      
      if (!isDir && unixfs.data) {
        size = unixfs.data.length;
      }
      
      return {
        found: true,
        name: name,
        cid: currentCID,
        size: size,
        isDir: isDir,
        modTime: new Date().toISOString()
      };
      
    } catch (error) {
      console.error(`[storacha] Stat failed: ${error.message}`);
      return { found: false };
    }
  },

  async findUploadByCID(cid) {
    let cursor;
    do {
      const res = await client.capability.upload.list({ cursor });
      if (!res || !res.results) break;
      
      for (const upload of res.results) {
        const rootCID = upload.root.toString();
        if (rootCID === cid) {
          const size = upload.shards?.reduce((sum, s) => sum + (s.size || 0), 0) || 0;
          return {
            cid: rootCID,
            size: size,
            modTime: upload.insertedAt || new Date().toISOString()
          };
        }
      }
      
      cursor = res.cursor;
    } while (cursor);
    
    return null;
  },
  
  async download({ cid }) {
    if (!client) throw new Error('Client not initialized');
    
    // Fetch from IPFS gateway
    const gatewayUrl = `https://w3s.link/ipfs/${cid}`;
    const response = await fetch(gatewayUrl);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch from gateway: ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    const data = Buffer.from(buffer).toString('base64');
    
    return { data };
  },
  
  async remove({ cid }) {
    if (!client) throw new Error('Client not initialized');
    
    try {
      // Parse the root CID and remove the upload
      const rootCID = CID.parse(cid);
      const result = await client.capability.upload.remove(rootCID);
      
      if (result.error) {
        throw new Error(`Remove failed: ${result.error.message}`);
      }
      
      return { removed: true };
    } catch (error) {
      console.error(`[storacha] Remove failed for ${cid}: ${error.message}`);
      throw error;
    }
  },

  async copy({ cid, remote, size }) {
    if (!client) throw new Error('Client not initialized');
    if (!currentSpace) throw new Error('No space selected');
    
    // Server-side copy: CID already exists in IPFS, just return success
    // Storacha manages the uploads automatically
    return { cid: cid };
  },

  async fetchBlock(cid) {
    const res = await fetch(
      `https://ipfs.io/ipfs/${cid}?format=raw`,
      {
        headers: {
          'Accept': 'application/vnd.ipld.raw'
        }
      }
    )
    if (!res.ok) throw new Error(`Failed fetching block: ${res.status}`)
    
    const bytes = new Uint8Array(await res.arrayBuffer())
    return bytes
  },

  async createFileBlock({ content }) {
    try {
      const contentBytes = Buffer.isBuffer(content) 
        ? content 
        : Buffer.from(content, 'base64');
      
      const unixfs = new UnixFS({
        type: 'file',
        data: contentBytes
      });
      
      const node = dagPB.prepare({
        Data: unixfs.marshal(),
        Links: []
      });
      
      const bytes = dagPB.encode(node);
      const hash = await sha256.digest(bytes);
      const cid = CID.create(1, dagPB.code, hash);
      
      return {
        cid: cid.toString(),
        data: node.Data,
        links: [],
        isDir: false,
        rawBytes: Buffer.from(bytes).toString('base64')
      };
    } catch (error) {
      throw new Error(`Failed to create file block: ${error.message}`);
    }
  },

  async createEmptyDirectoryBlock() {
    try {
      const unixfs = new UnixFS({
        type: 'directory'
      });

      const node = dagPB.prepare({
        Data: unixfs.marshal(),
        Links: []
      });

      const bytes = dagPB.encode(node);

      const hash = await sha256.digest(bytes);
      const cid = CID.create(1, dagPB.code, hash);

      return {
        cid: cid,       // CID object
        isDir: true,
        links: [],
        bytes: Buffer.from(bytes)  // Buffer
      };

    } catch (error) {
      throw new Error(`Failed to create empty directory: ${error.message}`);
    }
  },

  /**
   * Rebuild a dag-pb directory node, either updating an existing link or
   * adding a new one if no link with that name exists yet.
   *
   * @param {dagPB.PBNode} oldNode  - the decoded dag-pb node to update
   * @param {{ name: string, cid: CID, size: number }} updatedLink
   * @returns {{ cid: CID, bytes: Buffer }}
   */
  async rebuildDirNode(oldNode, updatedLink) {
    let found = false;

    const links = oldNode.Links.map(l => {
      if (l.Name === updatedLink.name) {
        found = true;
        return {
          Name: l.Name,
          Tsize: updatedLink.size,
          Hash: updatedLink.cid   // must be a CID object
        };
      }
      return l;
    });

    // If the link didn't exist yet, append it
    if (!found) {
      links.push({
        Name: updatedLink.name,
        Tsize: updatedLink.size,
        Hash: updatedLink.cid
      });
    }

    // dag-pb requires links sorted by name
    links.sort((a, b) => {
      if (a.Name < b.Name) return -1;
      if (a.Name > b.Name) return 1;
      return 0;
    });

    const node = dagPB.prepare({
      Data: oldNode.Data,
      Links: links
    });

    const bytes = dagPB.encode(node);
    const hash = await sha256.digest(bytes);
    const cid = CID.create(1, dagPB.code, hash);

    return { cid, bytes: Buffer.from(bytes) };
  },

  async fetchDag(cid) {
    console.error(`Fetching DAG node for CID ${cid}...`);
    const bytes = await handlers.fetchBlock(cid);
    const node = dagPB.decode(bytes);
    console.error(`node ${cid} has ${node.Links.length} links and data size ${node.Data?.length ?? 0} bytes`);
    return node;
  },

  async mkdir({ cid, path, name }) {
    if (!client) throw new Error('Client not initialized');
    if (!currentSpace) throw new Error('No space selected');

    // ── 1. Locate the original upload record ──────────────────────────────
    const uploads = await client.capability.upload.list();
    console.error(`Looking for original upload with root CID ${cid} among ${uploads.results.length} uploads...`);

    const originalUpload = uploads.results.find(u => u.root.toString() === cid.toString());
    if (!originalUpload) {
      throw new Error(`Original upload with root ${cid} not found in your space.`);
    }

    const originalRootCID = CID.parse(cid);

    // ── 2. Walk the path to the target parent node ────────────────────────
    const pathParts = (path === '' || path === '/')
      ? []
      : path.split('/').filter(Boolean);

    const stack = []; // [{name, node}] breadcrumb trail from root down
    let currentNode = await handlers.fetchDag(cid);

    for (const part of pathParts) {
      const link = currentNode.Links.find(l => l.Name === part);
      if (!link) {
        throw new Error(`Subdir "${part}" not found under current node`);
      }
      stack.push({ name: part, node: currentNode });
      currentNode = await handlers.fetchDag(link.Hash.toString());
    }

    // ── 3. Create the new empty directory block ───────────────────────────
    const newDir = await handlers.createEmptyDirectoryBlock();

    // ── 4. Inject the new directory entry into the target parent ──────────
    let updated = await handlers.rebuildDirNode(currentNode, {
      name,
      cid: newDir.cid,
      size: newDir.bytes.length
    });

    // Collect all new/modified blocks (innermost first, root last)
    const blocksToWrite = [
      { cid: newDir.cid,   bytes: newDir.bytes   },
      { cid: updated.cid,  bytes: updated.bytes  }
    ];

    // ── 5. Bubble changes up the ancestor chain ───────────────────────────
    while (stack.length > 0) {
      const parent = stack.pop();
      updated = await handlers.rebuildDirNode(parent.node, {
        name: parent.name,      // the child's link name inside the parent
        cid: updated.cid,
        size: updated.bytes.length
      });
      blocksToWrite.push({ cid: updated.cid, bytes: updated.bytes });
    }

    const newRootCID = updated.cid;
    console.error(`New root CID: ${newRootCID}`);

    // ── 6. Build and upload a CAR containing only the changed blocks ──────
    const { writer, out } = await CarWriter.create([newRootCID]);
    const chunks = [];

    const readerPromise = (async () => {
      for await (const chunk of out) {
        chunks.push(chunk);
      }
    })();

    for (const block of blocksToWrite) {
      // Ensure cid is always a CID object
      const cidObj = typeof block.cid === 'string' ? CID.parse(block.cid) : block.cid;
      await writer.put({ cid: cidObj, bytes: block.bytes });
    }

    await writer.close();
    await readerPromise;

    const carBytes = Buffer.concat(chunks);
    console.error(`Uploading CAR (${carBytes.length} bytes)...`);

    const carBlob = new Blob([carBytes], { type: 'application/car' });
    let newShardCID;

    await client.uploadCAR(carBlob, {
      rootCID: newRootCID,
      onShardStored: meta => {
        newShardCID = meta.cid;
        console.error(`New shard CID: ${newShardCID}`);
      }
    });

    if (!newShardCID) {
      throw new Error('Failed to get shard CID from CAR upload');
    }

    // ── 7. Register the NEW root with OLD shards + NEW shard ─────────────
    //
    // The original shards still hold all the underlying file data blocks.
    // The new CAR shard holds only the changed dag-pb directory nodes.
    // Both are needed to fully reconstruct the new tree.
    //
    // Normalise every shard to a CID object — the list API can return plain
    // CID objects, {cid} wrappers, or strings depending on the SDK version.
    const normaliseCID = (s) => {
      if (s && s.constructor?.name === 'CID') return s;
      if (s && s.cid) return typeof s.cid === 'string' ? CID.parse(s.cid) : s.cid;
      if (typeof s === 'string') return CID.parse(s);
      return CID.parse(s.toString());
    };

    const allShards = [
      ...originalUpload.shards.map(normaliseCID),
      normaliseCID(newShardCID)
    ];
    await client.capability.upload.add(newRootCID, allShards);
    console.error(`Registered new root ${newRootCID} with ${allShards.length} shards (${originalUpload.shards.length} original + 1 new)`);

    // Check if old CID has a w3name - if so, create revision to update IPNS pointer
    const oldCIDStr = cid.toString();
    if (nameRegistry.has(oldCIDStr)) {
      try {
        const nameInfo = nameRegistry.get(oldCIDStr);
        const nameInstance = await loadNameKey(nameInfo.keyFile);
        
        // Publish revision pointing new CID to the same IPNS name
        const revision = await Name.v0(nameInstance, newRootCID);
        await Name.publish(revision, nameInstance.key);
        
        // Update registry with new CID
        nameRegistry.delete(oldCIDStr);
        nameRegistry.set(newRootCID.toString(), {
          name: nameInfo.name,
          ipnsName: nameInfo.ipnsName,
          keyFile: nameInfo.keyFile
        });
        
        // Update key file to point to new CID
        await saveNameKey(newRootCID.toString(), nameInstance);
        
        console.error(`[mkdir] Published w3name revision: ${nameInfo.ipnsName} -> ${newRootCID}`);
      } catch (err) {
        console.error(`[mkdir] Failed to update w3name revision: ${err.message}`);
      }
    } else {
      console.error(`[mkdir] No w3name key found for old CID ${oldCIDStr}. IPNS pointer not updated.`);
      console.error(`[mkdir] To enable IPNS updates, load the key file from ${W3NAME_DIR}`);
    }

    return { newRootCID: newRootCID.toString() };
  },

  /**
   * Remove a named link from a dag-pb directory node.
   * Throws if the link does not exist (so callers get a clear error).
   *
   * @param {dagPB.PBNode} node
   * @param {string} linkName
   * @returns {{ cid: CID, bytes: Buffer }}
   */
  async removeLinkFromNode(node, linkName) {
    const originalCount = node.Links.length;
    const links = node.Links.filter(l => l.Name !== linkName);

    if (links.length === originalCount) {
      throw new Error(`Entry "${linkName}" not found in directory node`);
    }

    // Links must remain sorted by name (dag-pb requirement)
    links.sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0));

    const rebuilt = dagPB.prepare({ Data: node.Data, Links: links });
    const bytes   = dagPB.encode(rebuilt);
    const hash    = await sha256.digest(bytes);
    const cid     = CID.create(1, dagPB.code, hash);

    return { cid, bytes: Buffer.from(bytes) };
  },

  /**
   * Remove a directory (or file) entry from an existing uploaded DAG tree.
   *
   * Works identically to mkdir in structure:
   *   1. Locate the upload record for the given root CID
   *   2. Walk `path` to the parent node that contains `name`
   *   3. Remove the link named `name` from that parent
   *   4. Bubble the changed nodes back up to a new root
   *   5. Upload a CAR of only the changed dag-pb nodes
   *   6. Register new root = old shards + new shard
   *
   * @param {{ cid: string, path: string, name: string }} params
   *   cid  — root CID of the existing upload
   *   path — slash-separated path to the parent directory ('' or '/' = root)
   *   name — name of the entry to remove from that parent
   */
  async rmdir({ cid, path, name }) {
    if (!client) throw new Error('Client not initialized');
    if (!currentSpace) throw new Error('No space selected');

    // ── 1. Locate the original upload record ──────────────────────────────
    const uploads = await client.capability.upload.list();
    console.error(`[rmdir] Looking for root CID ${cid} among ${uploads.results.length} uploads...`);

    const originalUpload = uploads.results.find(u => u.root.toString() === cid.toString());
    if (!originalUpload) {
      throw new Error(`Original upload with root ${cid} not found in your space.`);
    }

    // ── 2. Walk the path to the parent node that owns `name` ──────────────
    const pathParts = (path === '' || path === '/')
      ? []
      : path.split('/').filter(Boolean);

    const stack = []; // [{name, node}] breadcrumb trail from root down
    let currentNode = await handlers.fetchDag(cid);

    for (const part of pathParts) {
      const link = currentNode.Links.find(l => l.Name === part);
      if (!link) {
        throw new Error(`[rmdir] Subdir "${part}" not found under current node`);
      }
      stack.push({ name: part, node: currentNode });
      currentNode = await handlers.fetchDag(link.Hash.toString());
    }

    // ── 3. Remove the named entry from the target parent ──────────────────
    let updated = await handlers.removeLinkFromNode(currentNode, name);

    // Collect only the modified nodes (no new blocks — we're only removing)x
    const blocksToWrite = [
      { cid: updated.cid, bytes: updated.bytes }
    ];

    // ── 4. Bubble changes up the ancestor chain ───────────────────────────
    while (stack.length > 0) {
      const parent = stack.pop();
      updated = await handlers.rebuildDirNode(parent.node, {
        name: parent.name,
        cid:  updated.cid,
        size: updated.bytes.length
      });
      blocksToWrite.push({ cid: updated.cid, bytes: updated.bytes });
    }

    const newRootCID = updated.cid;
    console.error(`[rmdir] New root CID: ${newRootCID}`);

    // ── 5. Build and upload a CAR of only the changed dag-pb nodes ────────
    const { writer, out } = await CarWriter.create([newRootCID]);
    const chunks = [];

    const readerPromise = (async () => {
      for await (const chunk of out) chunks.push(chunk);
    })();

    for (const block of blocksToWrite) {
      const cidObj = typeof block.cid === 'string' ? CID.parse(block.cid) : block.cid;
      await writer.put({ cid: cidObj, bytes: block.bytes });
    }

    await writer.close();
    await readerPromise;

    const carBytes = Buffer.concat(chunks);
    console.error(`[rmdir] Uploading CAR (${carBytes.length} bytes)...`);

    const carBlob = new Blob([carBytes], { type: 'application/car' });
    let newShardCID;

    await client.uploadCAR(carBlob, {
      rootCID: newRootCID,
      onShardStored: meta => {
        newShardCID = meta.cid;
        console.error(`[rmdir] New shard CID: ${newShardCID}`);
      }
    });

    if (!newShardCID) {
      throw new Error('[rmdir] Failed to get shard CID from CAR upload');
    }

    // ── 6. Register the NEW root with OLD shards + NEW shard ──────────────
    const normaliseCID = (s) => {
      if (s && s.constructor?.name === 'CID') return s;
      if (s && s.cid) return typeof s.cid === 'string' ? CID.parse(s.cid) : s.cid;
      if (typeof s === 'string') return CID.parse(s);
      return CID.parse(s.toString());
    };

    const allShards = [
      ...originalUpload.shards.map(normaliseCID),
      normaliseCID(newShardCID)
    ];
    await client.capability.upload.add(newRootCID, allShards);
    console.error(`[rmdir] Registered new root ${newRootCID} with ${allShards.length} shards`);

    // Check if old CID has a w3name - if so, create revision to update IPNS pointer
    const oldCIDStr = cid.toString();
    if (nameRegistry.has(oldCIDStr)) {
      try {
        const nameInfo = nameRegistry.get(oldCIDStr);
        const nameInstance = await loadNameKey(nameInfo.keyFile);
        
        // Publish revision pointing new CID to the same IPNS name
        const revision = await Name.v0(nameInstance, newRootCID);
        await Name.publish(revision, nameInstance.key);
        
        // Update registry with new CID
        nameRegistry.delete(oldCIDStr);
        nameRegistry.set(newRootCID.toString(), {
          name: nameInfo.name,
          ipnsName: nameInfo.ipnsName,
          keyFile: nameInfo.keyFile
        });
        
        // Update key file to point to new CID
        await saveNameKey(newRootCID.toString(), nameInstance);
        
        console.error(`[rmdir] Published w3name revision: ${nameInfo.ipnsName} -> ${newRootCID}`);
      } catch (err) {
        console.error(`[rmdir] Failed to update w3name revision: ${err.message}`);
      }
    } else {
      console.error(`[rmdir] No w3name key found for old CID ${oldCIDStr}. IPNS pointer not updated.`);
      console.error(`[rmdir] To enable IPNS updates, load the key file from ${W3NAME_DIR}`);
    }

    return { newRootCID: newRootCID.toString() };
  },

  async createCAR({ rootCID, blocks }) {
    try {
      const rootCidParsed = CID.parse(rootCID);
      const { writer, out } = CarWriter.create([rootCidParsed]);
      
      const chunks = [];
      const readerPromise = (async () => {
        for await (const chunk of out) {
          chunks.push(chunk);
        }
      })();
      
      // Add all blocks to the CAR
      for (const block of blocks) {
        const blockBytes = Buffer.from(block.rawBytes, 'base64');
        const blockCID = CID.parse(block.cid);
        await writer.put({ cid: blockCID, bytes: blockBytes });
      }
      
      await writer.close();
      await readerPromise;
      
      const carBytes = Buffer.concat(chunks);
      
      return {
        carBytes: carBytes.toString('base64'),
        size: carBytes.length
      };
    } catch (error) {
      throw new Error(`Failed to create CAR: ${error.message}`);
    }
  },

  async uploadCAR({ carData, rootCID }) {
    if (!client) throw new Error('Client not initialized');
    if (!currentSpace) throw new Error('No space selected');
    
    try {
      const carBytes = Buffer.from(carData, 'base64');
      const carBlob = new Blob([carBytes], { type: 'application/car' });
      
      let newShardCID = null;
      
      await client.uploadCAR(carBlob, {
        rootCID: CID.parse(rootCID),
        onShardStored: (meta) => {
          newShardCID = meta.cid.toString();
        }
      });
      
      if (!newShardCID) {
        throw new Error('Failed to get shard CID from upload');
      }
      
      return { shardCID: newShardCID };
    } catch (error) {
      throw new Error(`Failed to upload CAR: ${error.message}`);
    }
  },

  async getUploads({ rootCID }) {
    if (!client) throw new Error('Client not initialized');
    if (!currentSpace) throw new Error('No space selected');

    // Normalise rootCID — accept both string and CID object
    const targetStr = rootCID.toString();

    try {
      const uploads = [];

      let cursor;
      do {
        const res = await client.capability.upload.list({ cursor });
        if (!res || !res.results) break;

        for (const upload of res.results) {
          if (upload.root.toString() !== targetStr) continue;

          // Storacha shard entries can be plain CID objects, {cid} wrappers,
          // or IPLD link objects ({'/': '...'}). Normalise all forms.
          const shardCIDs = (upload.shards || []).map(s => {
            if (typeof s === 'string') return s;
            if (s && typeof s.toString === 'function' && s.constructor?.name === 'CID') return s.toString();
            if (s && s.cid) return s.cid.toString();
            // fallback — call toString() and hope for the best
            return s.toString();
          });

          uploads.push({
            cid:    upload.root.toString(),
            root:   upload.root.toString(),
            shards: shardCIDs,
            size:   upload.shards?.reduce((sum, s) => sum + (s.size || 0), 0) || 0,
            time:   upload.insertedAt || new Date().toISOString()
          });
        }

        cursor = res.cursor;
      } while (cursor);
      
      return uploads;
    } catch (error) {
      console.error(`Failed to get uploads: ${error.message}`);
      return [];
    }
  },

  async registerShards({ rootCID, shards }) {
    if (!client) throw new Error('Client not initialized');
    if (!currentSpace) throw new Error('No space selected');
    
    try {
      const rootCidParsed = CID.parse(rootCID);
      const shardCIDs = shards.map(s => CID.parse(s));
      
      await client.capability.upload.add(rootCidParsed, shardCIDs);
      
      return { success: true };
    } catch (error) {
      throw new Error(`Failed to register shards: ${error.message}`);
    }
  },

  async getRootCID() {
    if (!client) throw new Error('Client not initialized');
    if (!currentSpace) throw new Error('No space selected');
    
    try {
      // Get the most recent upload's root CID
      const res = await client.capability.upload.list({ cursor: undefined });
      
      if (res && res.results && res.results.length > 0) {
        const latestUpload = res.results[0];
        return { rootCID: latestUpload.root.toString() };
      }
      
      throw new Error('No uploads found');
    } catch (error) {
      throw new Error(`Failed to get root CID: ${error.message}`);
    }
  },

  async whoami() {
    if (!client) throw new Error('Client not initialized');
    
    const accounts = client.accounts();
    const spaces = client.spaces();
    
    return {
      accounts: Object.keys(accounts),
      spaces: spaces.map(s => ({ did: s.did(), name: s.name() })),
      currentSpace: currentSpace?.did()
    };
  }

};

// Process incoming requests
rl.on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch (e) {
    console.log(JSON.stringify({ 
      id: 0, 
      success: false, 
      error: `Invalid JSON: ${e.message}` 
    }));
    return;
  }
  
  const { id, method, params } = request;
  
  try {
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Unknown method: ${method}`);
    }
    
    const result = await handler(params || {});
    console.log(JSON.stringify({ id, success: true, result }));
  } catch (error) {
    console.log(JSON.stringify({ 
      id, 
      success: false, 
      error: error.message 
    }));
  }
});

// Handle process termination
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// Signal ready
console.error('[storacha-bridge] Ready');