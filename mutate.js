import * as Client from '@storacha/client'
import * as dagPB from "@ipld/dag-pb"
import { UnixFS } from "ipfs-unixfs"
import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
import { CarWriter } from "@ipld/car"
import fetch from 'node-fetch'


const OLD_ROOT = "bafybeic5l57vn2jaferlpeaoczoj4vxfa6oi5fktnbf4cnvils3kxelnmu"

// Path to mutate
const TARGET_DIR = "sub"
const TARGET_FILE = "info.txt"
const NEW_CONTENT = "edited via gateway mutation\n"

// ----------------------------------------

// Fetch raw block via trustless gateway
async function fetchBlock(cid) {
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
}

async function fetchDag(cid) {
  const bytes = await fetchBlock(cid)
  const node = dagPB.decode(bytes)
  return node
}

// Create UnixFS file block
async function createFileBlock(content) {
  const unixfs = new UnixFS({
    type: "file",
    data: Buffer.from(content)
  })

  const node = dagPB.prepare({
    Data: unixfs.marshal(),
    Links: []
  })

  const bytes = dagPB.encode(node)
  const hash = await sha256.digest(bytes)
  const cid = CID.create(1, dagPB.code, hash)

  return { cid, bytes }
}

// Rebuild directory node
async function rebuildDirNode(oldNode, updatedLink) {
  const links = oldNode.Links.map(l =>
    l.Name === updatedLink.name
      ? {
          Name: l.Name,
          Tsize: updatedLink.size,
          Hash: updatedLink.cid
        }
      : l
  )

  const node = dagPB.prepare({
    Data: oldNode.Data,
    Links: links
  })

  const bytes = dagPB.encode(node)
  const hash = await sha256.digest(bytes)
  const cid = CID.create(1, dagPB.code, hash)

  return { cid, bytes }
}

async function main() {
  console.log("Creating Storacha client...")
  const client = await Client.create()
  
  if (!client.currentSpace()) {
    return
  }

  console.log("Finding original upload...")
  const oldRootCID = CID.parse(OLD_ROOT)
  const uploads = await client.capability.upload.list()
  const originalUpload = uploads.results.find(u => u.root.toString() === oldRootCID.toString())
  
  if (!originalUpload) {
    throw new Error(`Original upload with root ${OLD_ROOT} not found in your space. Did you upload test-dir2?`)
  }
  
  console.log(`Found original upload with ${originalUpload.shards?.length || 0} shards`)

  // Step 2: Fetch only the directory structure blocks (not file contents)
  console.log("\nFetching directory structure...")
  const rootNode = await fetchDag(OLD_ROOT)

  const subLink = rootNode.Links.find(l => l.Name === TARGET_DIR)
  if (!subLink) throw new Error("Subdir not found")

  const subNode = await fetchDag(subLink.Hash.toString())

  console.log("Creating new file block...")
  const newFile = await createFileBlock(NEW_CONTENT)

  console.log("Rebuilding subdir node...")
  const newSub = await rebuildDirNode(subNode, {
    name: TARGET_FILE,
    cid: newFile.cid,
    size: newFile.bytes.length
  })

  console.log("Rebuilding root node...")
  const newRoot = await rebuildDirNode(rootNode, {
    name: TARGET_DIR,
    cid: newSub.cid,
    size: newSub.bytes.length
  })

  console.log("\nBuilding CAR with only new blocks...")
  const { writer, out } = CarWriter.create([newRoot.cid])

  const chunks = []
  const readerPromise = (async () => {
    for await (const chunk of out) {
      chunks.push(chunk)
    }
  })()

  await writer.put({ cid: newFile.cid, bytes: newFile.bytes })
  await writer.put({ cid: newSub.cid, bytes: newSub.bytes })
  await writer.put({ cid: newRoot.cid, bytes: newRoot.bytes })

  await writer.close()
  await readerPromise

  const carBytes = Buffer.concat(chunks)
  console.log(`CAR size: ${carBytes.length} bytes (only 3 blocks!)`)

  // Step 4: Upload the new CAR to get its shard CID
  console.log("\nUploading new CAR...")
  const carBlob = new Blob([carBytes], { type: 'application/car' })
  
  let newShardCID
  await client.uploadCAR(carBlob, {
    rootCID: newRoot.cid,
    onShardStored: (meta) => {
      newShardCID = meta.cid
      console.log(`New shard CID: ${newShardCID}`)
    }
  })

  if (!newShardCID) {
    throw new Error("Failed to get shard CID from upload")
  }

  // Step 6: register old shards
  console.log("Registering old shards...")
  const allShards = originalUpload.shards
  console.log(`Total shards: ${allShards.length} (${originalUpload.shards?.length || 0} old + 1 new)`)
  
  await client.capability.upload.add(newRoot.cid, allShards)

  console.log(newRoot.cid.toString())
  console.log(`\nView your content at: https://storacha.link/ipfs/${newRoot.cid}`)
}

main().catch(err => {
  console.error("\n❌ Error:", err)
  process.exit(1)
})
