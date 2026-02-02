// sdk-wrapper.js - Entry point for bundling the Storacha client
import * as Client from '@storacha/client';

// Export the client module to the global scope
globalThis.StorachaClient = Client;
