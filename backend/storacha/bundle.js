// bundle.js - Script to bundle the Storacha SDK for use with v8go
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function bundle() {
  try {
    console.log('Bundling Storacha SDK...');
    
    const result = await esbuild.build({
      entryPoints: ['./sdk-wrapper.js'],
      bundle: true,
      format: 'iife',
      globalName: 'StorachaSDK',
      outfile: 'storacha-sdk-bundle.js',
      platform: 'browser',
      target: 'es2020',
      minify: false, // Keep readable for debugging
      sourcemap: false,
      // Define Node.js globals that might be referenced
      define: {
        'process.env.NODE_ENV': '"production"',
        'global': 'globalThis'
      }
    });
    
    console.log('Bundle created successfully!');
    console.log('Output:', path.resolve('storacha-sdk-bundle.js'));
    
    // Read all components
    console.log('Creating combined bundle with polyfills and bridge...');
    
    const polyfills = fs.readFileSync('polyfills.js', 'utf8');
    const sdkBundle = fs.readFileSync('storacha-sdk-bundle.js', 'utf8');
    const bridge = fs.readFileSync('bridge.js', 'utf8');
    
    const combined = `// Combined Storacha SDK + Polyfills + Bridge for rclone
// Auto-generated - do not edit manually
// Generated: ${new Date().toISOString()}

// ============================================
// PART 1: V8 Polyfills (Browser APIs for v8go)
// ============================================
${polyfills}

// ============================================
// PART 2: Storacha SDK Bundle
// ============================================
${sdkBundle}

// ============================================
// PART 3: Bridge Layer
// ============================================
${bridge}

console.log('[storacha] Bundle loaded successfully');
`;
    
    fs.writeFileSync('storacha-bundle-combined.js', combined);
    console.log('Combined bundle created:', path.resolve('storacha-bundle-combined.js'));
    
  } catch (error) {
    console.error('Bundle failed:', error);
    process.exit(1);
  }
}

bundle();
