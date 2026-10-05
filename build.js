const fs = require('fs');
const path = require('path');

const baseManifest = require('./manifest.base.json');

// Chromium 内核浏览器（Edge / Chrome）：后台用 service worker。
const manifest = {
  ...baseManifest,
  background: {
    service_worker: "background.js"
  }
};

const CHROME_DIR = path.join(__dirname, 'dist', 'chrome');

// Define assets to copy (add any other files/folders your extension needs)
const ASSETS_TO_COPY = ['background.js', 'weapi.js', 'images'];

function build(outputDir) {
  console.log(`Building for Chromium...`);

  // 1. Create the output directory
  fs.mkdirSync(outputDir, { recursive: true });

  // 2. Write the tailored manifest.json
  fs.writeFileSync(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  // 3. Copy source files to the output directory
  ASSETS_TO_COPY.forEach(asset => {
    const srcPath = path.join(__dirname, asset);
    const destPath = path.join(outputDir, asset);

    if (fs.existsSync(srcPath)) {
      // fs.cpSync is supported in Node.js >= 16.7.0
      fs.cpSync(srcPath, destPath, { recursive: true });
    } else {
      console.warn(`[WARNING] Asset not found: ${asset}`);
    }
  });

  console.log(`Build complete! Output: ${outputDir}\n`);
}

fs.rmSync(path.join(__dirname, 'dist'), { recursive: true, force: true });

build(CHROME_DIR);
