// storacha-bridge-test.mjs
// Tests for mkdir via uploadDirectory and mkdir after upload

import assert from 'assert'
import { randomBytes } from 'crypto'
import { handlers } from './storacha-bridge.mjs'

async function testMkdirViaUploadDirectory() {
  await handlers.init({ spaceDID: 'did:key:z6MksMFjn116A1jtoEEEovrf8FLPzW5pVfW4GTWBe4mPaQ11', email: 'sambhavjain170944@gmail.com' })
  console.log('Test: mkdir via uploadDirectory')
  // Simulate uploading a directory
  const files = [
    { name: 'file1.txt', data: Buffer.from('abc').toString('base64') },
    { name: 'file2.txt', data: Buffer.from('def').toString('base64') }
  ]
  const uploadResult = await handlers.uploadDirectory({ files })
  console.log('Upload result:', uploadResult)
  const mkdirResult = await handlers.mkdir({ cid: uploadResult.cid, path: '', name: 'subdir' })
  console.log('Passed: mkdir via uploadDirectory')
}

/**
 * Test: mkdir inside a nested existing subdirectory ("mid data").
 *
 * Directory tree after uploadDirectory:
 *   root/
 *     level1/
 *       level2/
 *         deep.txt
 *       sibling.txt
 *     top.txt
 *
 * We then call mkdir({ cid: root, path: 'level1/level2', name: 'new-subdir' })
 * and verify the new root resolves correctly:
 *   root'/
 *     level1/
 *       level2/
 *         deep.txt
 *         new-subdir/   ← injected here, mid-tree
 *       sibling.txt
 *     top.txt
 */

async function testMkdirMidData() {
  await handlers.init({
    spaceDID: 'did:key:z6MksMFjn116A1jtoEEEovrf8FLPzW5pVfW4GTWBe4mPaQ11',
    email: 'sambhavjain170944@gmail.com'
  })

  console.log('Test: mkdir at nested path (mid data)')

  // ── 1. Upload a nested directory tree ────────────────────────────────────
  // The Storacha client reconstructs the hierarchy from file paths,
  // so we pass paths that include subdirectory prefixes.
  const files = [
    { name: 'top.txt',                data: Buffer.from('top level file').toString('base64') },
    { name: 'level1/sibling.txt',     data: Buffer.from('sibling').toString('base64') },
    { name: 'level1/level2/deep.txt', data: Buffer.from('deep file').toString('base64') }
  ]

  const uploadResult = await handlers.uploadDirectory({ files })
  const rootCID = uploadResult.cid
  console.log(`Uploaded root CID: ${rootCID}`)

  // ── 2. mkdir inside level1/level2 ────────────────────────────────────────
  const mkdirResult = await handlers.mkdir({
    cid:  rootCID,
    path: 'level1/level2',   // navigate into this existing subdir
    name: 'new-subdir'        // create this entry inside it
  })

  console.log(`New root CID after mkdir: ${mkdirResult.newRootCID}`)

  assert(mkdirResult.newRootCID, 'mkdir should return a newRootCID')
  assert(
    mkdirResult.newRootCID !== rootCID,
    'new root CID must differ from original (tree was mutated)'
  )

  // ── 3. Verify the new tree via DAG traversal ──────────────────────────────
  // Walk: newRoot → level1 → level2 → new-subdir should exist
  const newRoot  = await handlers.fetchDag(mkdirResult.newRootCID)
  const level1Link = newRoot.Links.find(l => l.Name === 'level1')
  assert(level1Link, 'level1 link must still exist in new root')

  const level1Node = await handlers.fetchDag(level1Link.Hash.toString())
  const level2Link = level1Node.Links.find(l => l.Name === 'level2')
  assert(level2Link, 'level2 link must still exist under level1')

  const level2Node = await handlers.fetchDag(level2Link.Hash.toString())

  const deepLink     = level2Node.Links.find(l => l.Name === 'deep.txt')
  const newSubdirLink = level2Node.Links.find(l => l.Name === 'new-subdir')

  assert(deepLink,      'deep.txt must still exist inside level2 (existing data preserved)')
  assert(newSubdirLink, 'new-subdir must exist inside level2 (newly created)')

  // Confirm new-subdir is itself an empty directory (no links, UnixFS dir)
  const newSubdirNode = await handlers.fetchDag(newSubdirLink.Hash.toString())
  assert.strictEqual(newSubdirNode.Links.length, 0, 'new-subdir should be an empty directory')

  // Confirm siblings at level1 are untouched
  const siblingLink = level1Node.Links.find(l => l.Name === 'sibling.txt')
  assert(siblingLink, 'sibling.txt must still exist under level1 (unrelated sibling preserved)')

  // Confirm top.txt at root is untouched
  const topLink = newRoot.Links.find(l => l.Name === 'top.txt')
  assert(topLink, 'top.txt must still exist at root (unrelated file preserved)')

  console.log('Passed: mkdir at nested path (mid data)')
}

/**
 * Test: mkdir inside a nested existing subdirectory with LARGE files.
 *
 * Large files (6–8 MB each, ~21 MB total) force the uploadDirectory to produce
 * multiple CAR shards. This validates that mkdir correctly carries ALL original
 * shards when registering the new root — not just the newly created shard —
 * so the full file data remains retrievable after the operation.
 *
 * Directory tree after uploadDirectory:
 *   root/
 *     top.txt          (6 MB)
 *     level1/
 *       sibling.txt    (7 MB)
 *       level2/
 *         deep.txt     (8 MB)
 *
 * After mkdir({ cid: root, path: 'level1/level2', name: 'new-subdir' }):
 *   root'/
 *     top.txt
 *     level1/
 *       sibling.txt
 *       level2/
 *         deep.txt
 *         new-subdir/   ← injected mid-tree
 */

const MB = 1024 * 1024

async function testMkdirMidDataLarge() {
  await handlers.init({
    spaceDID: 'did:key:z6MksMFjn116A1jtoEEEovrf8FLPzW5pVfW4GTWBe4mPaQ11',
    email: 'sambhavjain170944@gmail.com'
  })

  console.log('Test: mkdir at nested path with large files (multi-shard)')

  // ── 1. Build large random buffers ────────────────────────────────────────
  // crypto.randomBytes produces incompressible data so the CAR won't be
  // deflated below the shard threshold by the encoder.
  console.log('Generating large file buffers (~21 MB total)...')
  const topData     = randomBytes(6 * MB)   // 6 MB — root level
  const siblingData = randomBytes(7 * MB)   // 7 MB — level1 sibling
  const deepData    = randomBytes(8 * MB)   // 8 MB — deepest file

  const files = [
    { name: 'top.txt',                data: topData.toString('base64') },
    { name: 'level1/sibling.txt',     data: siblingData.toString('base64') },
    { name: 'level1/level2/deep.txt', data: deepData.toString('base64') }
  ]

  // ── 2. Upload — expect multiple shards ───────────────────────────────────
  console.log('Uploading large directory (~21 MB, expect multiple shards)...')
  const uploadResult = await handlers.uploadDirectory({ files })
  const rootCID = uploadResult.cid
  console.log(`Uploaded root CID: ${rootCID}`)

  // Fetch the original upload record and confirm multi-shard
  const originalUploads = await handlers.getUploads({ rootCID })
  assert(originalUploads.length > 0, 'upload record must exist')
  const originalShards = originalUploads[0].shards
  console.log(`Original shard count: ${originalShards.length}`)

  // ── 3. mkdir inside level1/level2 ────────────────────────────────────────
  console.log('Running mkdir at level1/level2/new-subdir...')
  const mkdirResult = await handlers.mkdir({
    cid:  rootCID,
    path: 'level1/level2',
    name: 'new-subdir'
  })

  console.log(`New root CID after mkdir: ${mkdirResult.newRootCID}`)
  assert(mkdirResult.newRootCID, 'mkdir must return a newRootCID')
  assert(
    mkdirResult.newRootCID !== rootCID,
    'new root CID must differ from original (tree was mutated)'
  )

  // ── 4. Confirm new root was registered with ALL original shards ──────────
  // If mkdir only registered [newShardCID], the large file blocks would be
  // missing and any gateway fetch for the files would fail.
  const newUploads = await handlers.getUploads({ rootCID: mkdirResult.newRootCID })
  assert(newUploads.length > 0, 'new upload record must exist after mkdir')
  const newShards = newUploads[0].shards
  console.log(`New root shard count: ${newShards.length}`)
  assert(
    newShards.length === originalShards.length + 1,
    `new root should have ${originalShards.length + 1} shards (original + 1 new dag-pb shard), got ${newShards.length}`
  )
  for (const s of originalShards) {
    assert(
      newShards.includes(s),
      `original shard ${s} must be present in new root's shard list`
    )
  }

  // ── 5. Verify the DAG structure ──────────────────────────────────────────
  const newRoot     = await handlers.fetchDag(mkdirResult.newRootCID)
  const level1Link  = newRoot.Links.find(l => l.Name === 'level1')
  assert(level1Link, 'level1 link must still exist in new root')

  const level1Node  = await handlers.fetchDag(level1Link.Hash.toString())
  const level2Link  = level1Node.Links.find(l => l.Name === 'level2')
  assert(level2Link, 'level2 link must still exist under level1')

  const level2Node     = await handlers.fetchDag(level2Link.Hash.toString())
  const deepLink       = level2Node.Links.find(l => l.Name === 'deep.txt')
  const newSubdirLink  = level2Node.Links.find(l => l.Name === 'new-subdir')

  assert(deepLink,     'deep.txt must still exist inside level2 (existing data preserved)')
  assert(newSubdirLink,'new-subdir must exist inside level2 (newly created)')

  // new-subdir should be an empty directory
  const newSubdirNode = await handlers.fetchDag(newSubdirLink.Hash.toString())
  assert.strictEqual(newSubdirNode.Links.length, 0, 'new-subdir should be an empty directory')

  // Unrelated nodes at level1 and root must be untouched
  const siblingLink = level1Node.Links.find(l => l.Name === 'sibling.txt')
  assert(siblingLink, 'sibling.txt must still exist under level1')

  const topLink = newRoot.Links.find(l => l.Name === 'top.txt')
  assert(topLink, 'top.txt must still exist at root')

  console.log('Passed: mkdir at nested path with large files (multi-shard)')
}

/**
 * Test: rmdir at a nested path with large files (multi-shard).
 *
 * Starting tree (uploaded with ~21 MB of random data to force multiple shards):
 *   root/
 *     top.txt          (6 MB)
 *     level1/
 *       sibling.txt    (7 MB)
 *       level2/
 *         deep.txt     (8 MB)
 *         to-remove/   (empty dir, created via mkdir)
 *
 * After rmdir({ cid: root', path: 'level1/level2', name: 'to-remove' }):
 *   root''/
 *     top.txt                  <- untouched
 *     level1/
 *       sibling.txt            <- untouched
 *       level2/
 *         deep.txt             <- untouched
 *                              <- to-remove is gone
 */

async function testRmdirMidDataLarge() {
  await handlers.init({
    spaceDID: 'did:key:z6MksMFjn116A1jtoEEEovrf8FLPzW5pVfW4GTWBe4mPaQ11',
    email: 'sambhavjain170944@gmail.com'
  })

  console.log('Test: rmdir at nested path with large files (multi-shard)')

  // -- 1. Upload a large nested directory tree --------------------------------
  console.log('Generating large file buffers (~21 MB total)...')
  const topData     = randomBytes(6 * MB)
  const siblingData = randomBytes(7 * MB)
  const deepData    = randomBytes(8 * MB)

  const files = [
    { name: 'top.txt',                data: topData.toString('base64') },
    { name: 'level1/sibling.txt',     data: siblingData.toString('base64') },
    { name: 'level1/level2/deep.txt', data: deepData.toString('base64') }
  ]

  console.log('Uploading large directory (~21 MB)...')
  const uploadResult = await handlers.uploadDirectory({ files })
  const originalRootCID = uploadResult.cid
  console.log('Uploaded root CID:', originalRootCID)

  // Confirm multi-shard
  const originalUploads = await handlers.getUploads({ rootCID: originalRootCID })
  assert(originalUploads.length > 0, 'upload record must exist after uploadDirectory')

  // -- 2. mkdir to create the directory we will later remove -----------------
  console.log('Creating to-remove/ via mkdir...')
  const mkdirResult = await handlers.mkdir({
    cid:  originalRootCID,
    path: 'level1/level2',
    name: 'to-remove'
  })
  const rootAfterMkdir = mkdirResult.newRootCID
  console.log('Root after mkdir:', rootAfterMkdir)

  // Sanity: to-remove exists
  const pmRoot   = await handlers.fetchDag(rootAfterMkdir)
  const pmLevel1 = await handlers.fetchDag(pmRoot.Links.find(l => l.Name === 'level1').Hash.toString())
  const pmLevel2 = await handlers.fetchDag(pmLevel1.Links.find(l => l.Name === 'level2').Hash.toString())
  assert(pmLevel2.Links.find(l => l.Name === 'to-remove'), 'to-remove must exist after mkdir (sanity)')

  // -- 3. rmdir the directory ------------------------------------------------
  console.log('Running rmdir at level1/level2/to-remove...')
  const rmdirResult = await handlers.rmdir({
    cid:  rootAfterMkdir,
    path: 'level1/level2',
    name: 'to-remove'
  })

  console.log('New root CID after rmdir:', rmdirResult.newRootCID)
  assert(rmdirResult.newRootCID, 'rmdir must return a newRootCID')
  assert(
    rmdirResult.newRootCID !== rootAfterMkdir,
    'new root CID must differ from pre-rmdir root'
  )

  // -- 4. Confirm new root was registered with all shards --------------------
  const rmdirUploads = await handlers.getUploads({ rootCID: rmdirResult.newRootCID })
  assert(rmdirUploads.length > 0, 'new upload record must exist after rmdir')
  const rmdirShards = rmdirUploads[0].shards
  console.log('Post-rmdir shard count:', rmdirShards.length)

  const mkdirUploads = await handlers.getUploads({ rootCID: rootAfterMkdir })
  const mkdirShards  = mkdirUploads[0].shards
  assert(
    rmdirShards.length === mkdirShards.length + 1,
    'expected ' + (mkdirShards.length + 1) + ' shards after rmdir, got ' + rmdirShards.length
  )
  for (const s of mkdirShards) {
    assert(rmdirShards.includes(s), 'shard ' + s + ' must be present in post-rmdir shard list')
  }

  // -- 5. Verify the DAG structure -------------------------------------------
  const newRoot    = await handlers.fetchDag(rmdirResult.newRootCID)
  const level1Link = newRoot.Links.find(l => l.Name === 'level1')
  assert(level1Link, 'level1 must still exist in new root')

  const level1Node = await handlers.fetchDag(level1Link.Hash.toString())
  const level2Link = level1Node.Links.find(l => l.Name === 'level2')
  assert(level2Link, 'level2 must still exist under level1')

  const level2Node  = await handlers.fetchDag(level2Link.Hash.toString())
  const removedLink = level2Node.Links.find(l => l.Name === 'to-remove')
  const deepLink    = level2Node.Links.find(l => l.Name === 'deep.txt')
  const siblingLink = level1Node.Links.find(l => l.Name === 'sibling.txt')
  const topLink     = newRoot.Links.find(l => l.Name === 'top.txt')

  assert(!removedLink, 'to-remove must NOT exist inside level2 after rmdir')
  assert(deepLink,     'deep.txt must still exist inside level2')
  assert(siblingLink,  'sibling.txt must still exist under level1')
  assert(topLink,      'top.txt must still exist at root')

  console.log('Passed: rmdir at nested path with large files (multi-shard)')
}


/**
 * Test: rmdir on a directory that exists in the original upload
 * (no mkdir involved â€” tests the real-world case).
 *
 * Uploaded tree:
 *   root/
 *     top.txt            (6 MB)
 *     level1/
 *       sibling.txt      (7 MB)
 *       to-remove/
 *         inner.txt      (4 MB)  <- directory is non-empty in the DAG,
 *                                   but rmdir just removes the link,
 *                                   it does not recurse (like POSIX rmdir)
 *       level2/
 *         deep.txt       (8 MB)
 *
 * After rmdir({ cid: root, path: 'level1', name: 'to-remove' }):
 *   root'/
 *     top.txt            <- untouched
 *     level1/
 *       sibling.txt      <- untouched
 *       level2/          <- untouched
 *         deep.txt
 *                        <- to-remove is gone
 */

async function testRmdirNative() {
  await handlers.init({
    spaceDID: 'did:key:z6MksMFjn116A1jtoEEEovrf8FLPzW5pVfW4GTWBe4mPaQ11',
    email: 'sambhavjain170944@gmail.com'
  })

  console.log('Test: rmdir on directory present in original upload (no mkdir)')

  // -- 1. Upload tree with to-remove/ already present ------------------------
  console.log('Generating file buffers...')
  const files = [
    { name: 'top.txt',                       data: randomBytes(6 * MB).toString('base64') },
    { name: 'level1/sibling.txt',            data: randomBytes(7 * MB).toString('base64') },
    { name: 'level1/to-remove/inner.txt',    data: randomBytes(4 * MB).toString('base64') },
    { name: 'level1/level2/deep.txt',        data: randomBytes(8 * MB).toString('base64') }
  ]

  console.log('Uploading (~25 MB, expect multiple shards)...')
  const uploadResult = await handlers.uploadDirectory({ files })
  const rootCID = uploadResult.cid
  console.log('Root CID:', rootCID)

  // Sanity: to-remove exists in the original upload
  const origRoot   = await handlers.fetchDag(rootCID)
  const origLevel1 = await handlers.fetchDag(origRoot.Links.find(l => l.Name === 'level1').Hash.toString())
  assert(
    origLevel1.Links.find(l => l.Name === 'to-remove'),
    'to-remove must exist in original upload (sanity)'
  )

  // -- 2. rmdir without any prior mkdir --------------------------------------
  console.log('Running rmdir at level1/to-remove...')
  const rmdirResult = await handlers.rmdir({
    cid:  rootCID,
    path: 'level1',
    name: 'to-remove'
  })

  console.log('New root CID after rmdir:', rmdirResult.newRootCID)
  assert(rmdirResult.newRootCID, 'rmdir must return a newRootCID')
  assert(
    rmdirResult.newRootCID !== rootCID,
    'new root CID must differ from original'
  )

  // -- 3. Confirm shard carryover --------------------------------------------
  const rmdirUploads = await handlers.getUploads({ rootCID: rmdirResult.newRootCID })
  assert(rmdirUploads.length > 0, 'new upload record must exist after rmdir')
  const rmdirShards = rmdirUploads[0].shards
  console.log('Post-rmdir shard count:', rmdirShards.length)

  // -- 4. Verify DAG structure -----------------------------------------------
  const newRoot    = await handlers.fetchDag(rmdirResult.newRootCID)
  const level1Link = newRoot.Links.find(l => l.Name === 'level1')
  assert(level1Link, 'level1 must still exist')

  const level1Node  = await handlers.fetchDag(level1Link.Hash.toString())
  const removedLink = level1Node.Links.find(l => l.Name === 'to-remove')
  const siblingLink = level1Node.Links.find(l => l.Name === 'sibling.txt')
  const level2Link  = level1Node.Links.find(l => l.Name === 'level2')
  const topLink     = newRoot.Links.find(l => l.Name === 'top.txt')

  assert(!removedLink, 'to-remove must NOT exist after rmdir')
  assert(siblingLink,  'sibling.txt must still exist under level1')
  assert(level2Link,   'level2 must still exist under level1')
  assert(topLink,      'top.txt must still exist at root')

  // level2/deep.txt should still be reachable
  const level2Node = await handlers.fetchDag(level2Link.Hash.toString())
  assert(level2Node.Links.find(l => l.Name === 'deep.txt'), 'deep.txt must still exist under level2')

  console.log('Passed: rmdir on directory present in original upload')
}

async function runTests() {
  await testMkdirViaUploadDirectory()
  await testMkdirMidData()
  await testMkdirMidDataLarge()
  await testRmdirMidDataLarge()
  await testRmdirNative()
  console.log('All tests passed.')
}

runTests().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
