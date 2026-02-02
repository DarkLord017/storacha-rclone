// Storacha SDK Bridge for rclone
// This bridge provides a simplified interface to the Storacha client for use with v8go

// Global state for the Storacha client
let storachaClient = null;
let currentSpace = null;

// Initialize the Storacha client
async function initClient(config) {
  try {
    // Import the Storacha client (will be bundled)
    const Client = globalThis.StorachaClient;
    
    if (!Client) {
      throw new Error('Storacha client module not loaded');
    }
    
    // Create client instance
    storachaClient = await Client.create({
      // Use provided store configuration if available
      // store: config.store
    });
    
    // Set the current space if provided
    if (config.spaceDID) {
      const spaces = storachaClient.spaces();
      const space = spaces.find(s => s.did() === config.spaceDID);
      if (space) {
        await storachaClient.setCurrentSpace(config.spaceDID);
        currentSpace = space;
      } else {
        throw new Error(`Space ${config.spaceDID} not found`);
      }
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Login with email
async function login(email) {
  try {
    if (!storachaClient) {
      throw new Error('Client not initialized');
    }
    
    await storachaClient.login(email);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get current user info
async function whoami() {
  try {
    if (!storachaClient) {
      throw new Error('Client not initialized');
    }
    
    const accounts = storachaClient.accounts();
    return { 
      success: true, 
      accounts: Object.keys(accounts).map(did => ({ did }))
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// List available spaces
async function listSpaces() {
  try {
    if (!storachaClient) {
      throw new Error('Client not initialized');
    }
    
    const spaces = storachaClient.spaces();
    return { 
      success: true, 
      spaces: spaces.map(s => ({ 
        did: s.did(), 
        name: s.name(),
        registered: s.registered()
      }))
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Upload a file
async function uploadFile(fileData, fileName) {
  try {
    if (!storachaClient) {
      throw new Error('Client not initialized');
    }
    
    if (!currentSpace) {
      throw new Error('No space selected');
    }
    
    // Create a Blob from the data
    const blob = new Blob([fileData], { type: 'application/octet-stream' });
    const file = new File([blob], fileName);
    
    // Upload the file
    const cid = await storachaClient.uploadFile(file);
    
    return { 
      success: true, 
      cid: cid.toString()
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Upload multiple files as a directory
async function uploadDirectory(files) {
  try {
    if (!storachaClient) {
      throw new Error('Client not initialized');
    }
    
    if (!currentSpace) {
      throw new Error('No space selected');
    }
    
    // Convert files array to File objects
    const fileObjects = files.map(f => {
      const blob = new Blob([f.data], { type: 'application/octet-stream' });
      return new File([blob], f.name);
    });
    
    // Upload directory
    const rootCid = await storachaClient.uploadDirectory(fileObjects);
    
    return { 
      success: true, 
      cid: rootCid.toString()
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// List uploads
async function listUploads(cursor, size) {
  try {
    if (!storachaClient) {
      throw new Error('Client not initialized');
    }
    
    const options = {};
    if (cursor) options.cursor = cursor;
    if (size) options.size = size;
    
    const result = await storachaClient.capability.upload.list(options);
    
    return { 
      success: true,
      uploads: result.results.map(r => ({
        root: r.root.toString(),
        shards: r.shards ? r.shards.map(s => s.toString()) : []
      })),
      cursor: result.cursor,
      size: result.size
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Remove an upload by CID
async function removeUpload(cidString) {
  try {
    if (!storachaClient) {
      throw new Error('Client not initialized');
    }
    
    // Parse CID string (you'll need to use the CID library)
    // For now, we'll pass it directly and let the SDK handle it
    await storachaClient.remove(cidString);
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Export functions for Go to call
globalThis.storachaBridge = {
  initClient,
  login,
  whoami,
  listSpaces,
  uploadFile,
  uploadDirectory,
  listUploads,
  removeUpload
};
