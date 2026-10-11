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

const DIST_ROOT = path.join(__dirname, 'dist');
const CHROME_DIR = path.join(DIST_ROOT, 'chrome');
const STAGING_DIR = path.join(DIST_ROOT, 'chrome.staging');

// 产物内容的唯一真源。清单漏一项 = 发布包里少一个文件，而少 LICENSE 这件事已经外流过 6 个版本
// （v1.1.0–v1.2.4 的扩展包都不含 GPL-3.0 全文，而 README 对外承诺「二改代码同样以 GPL-3.0 开源」）。
const ASSETS_TO_COPY = ['background.js', 'weapi.js', 'images', 'LICENSE'];

// 清单之外再独立钉一份「这个扩展的包必须有这些文件」。只拿 ASSETS_TO_COPY 当期望值会自我指涉 ——
// 把它改坏（v1.1.0–v1.2.4 就是这么连续 6 个版本漏掉 LICENSE 而构建照样成功的），期望值跟着一起变小，守卫全绿。
const REQUIRED_PACKAGE_FILES = ['manifest.json', 'background.js', 'weapi.js', 'LICENSE'];

function walkFiles(dir, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...walkFiles(path.join(dir, entry.name), rel));
    else found.push(rel);
  }
  return found;
}

// 清单展开成期望的文件集合（目录取全量递归）。
function expectedFileSet() {
  const expected = new Set(['manifest.json']);
  for (const asset of ASSETS_TO_COPY) {
    const srcPath = path.join(__dirname, asset);
    if (!fs.existsSync(srcPath)) throw new Error(`声明的资产在仓库里不存在: ${asset}`);
    if (fs.statSync(srcPath).isDirectory()) walkFiles(srcPath).forEach((f) => expected.add(`${asset}/${f}`));
    else expected.add(asset);
  }
  return expected;
}

// 包内容必须与声明清单严格相等：少件、多件都是构建失败，不是 warn。
// 「先出 manifest 再复制」和「缺件只 warn」会让一个残缺包看起来构建成功。
function assertPackageComplete(outputDir) {
  const actual = new Set(walkFiles(outputDir));
  const absent = REQUIRED_PACKAGE_FILES.filter((f) => !actual.has(f));
  if (absent.length) {
    throw new Error(`包里缺少必备文件: ${absent.join(', ')}（这份清单独立于 ASSETS_TO_COPY，专门用来抓清单本身被改坏）`);
  }

  const expected = expectedFileSet();
  const missing = [...expected].filter((f) => !actual.has(f));
  const extra = [...actual].filter((f) => !expected.has(f));
  if (missing.length || extra.length) {
    throw new Error(`包内容与声明清单不一致\n  缺少: ${missing.join(', ') || '无'}\n  多余: ${extra.join(', ') || '无'}`);
  }

  const background = fs.readFileSync(path.join(outputDir, 'background.js'), 'utf8');
  // 抓整个 importScripts(...) 调用的全部参数；只看第一个参数会在 v1.2.1 那种两文件形态上返回空集合（假绿）。
  const imported = [...background.matchAll(/importScripts\(([^)]*)\)/g)]
    .flatMap((m) => m[1].split(',').map((arg) => arg.trim().replace(/^["']|["']$/g, '')))
    .filter(Boolean);
  for (const file of imported) {
    if (!ASSETS_TO_COPY.includes(file)) throw new Error(`importScripts 引用了 ${file}，但它不在 ASSETS_TO_COPY 里`);
  }

  // 代码与 manifest 引用的图标都必须在包里（整串比对，不用 includes，免得前缀命中蒙过去）。
  const referenced = new Set([
    ...background.matchAll(/["'](images\/[^"']+\.png)["']/g).map((m) => m[1]),
    ...(manifest.icons ? Object.values(manifest.icons) : []),
    ...(manifest.action && manifest.action.default_icon ? Object.values(manifest.action.default_icon) : [])
  ]);
  for (const file of referenced) {
    if (!actual.has(file)) throw new Error(`代码或 manifest 引用了 ${file}，但包里没有被复制过去`);
  }

  // 源码里的端点主机必须逐个落在 host_permissions 内。
  const hosts = [...background.matchAll(/^const (?:MUSIC_HOST|INTERFACE_HOST|VIP_CENTER_HOST) = "([^"]+)";$/gm)].map((m) => m[1]);
  if (hosts.length !== 3) throw new Error(`期望 background.js 里有 3 个主机常量，实际 ${hosts.length}`);
  for (const host of hosts) {
    if (!manifest.host_permissions.includes(`*://${host}/*`)) {
      throw new Error(`${host} 不在 host_permissions 里，运行期请求会被平台拒掉`);
    }
  }
}

function build(outputDir) {
  console.log('Building for Chromium...');

  // 1. Create the output directory
  fs.mkdirSync(outputDir, { recursive: true });

  // 2. Copy source files to the output directory（缺件即停，不要造出一个"看起来成功"的残缺包）
  ASSETS_TO_COPY.forEach(asset => {
    const srcPath = path.join(__dirname, asset);
    const destPath = path.join(outputDir, asset);
    if (!fs.existsSync(srcPath)) throw new Error(`构建中止：声明的资产不存在 ${asset}`);
    // fs.cpSync is supported in Node.js >= 16.7.0
    fs.cpSync(srcPath, destPath, { recursive: true });
  });

  // 3. Write the tailored manifest last：先写 manifest 会让半成品目录短暂 self-consistent。
  fs.writeFileSync(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  assertPackageComplete(outputDir);
  console.log(`Package contents OK (${walkFiles(outputDir).length} files): ${[...expectedFileSet()].sort().join(', ')}`);
}

// 构建进临时目录，完整了才换掉 dist/chrome：Edge 用「加载解压缩的扩展」指向它时，
// 先 rm -rf 会让正在运行的扩展瞬间读不到文件。
fs.mkdirSync(DIST_ROOT, { recursive: true });
fs.rmSync(STAGING_DIR, { recursive: true, force: true });
build(STAGING_DIR);

const previous = path.join(DIST_ROOT, 'chrome.previous');
fs.rmSync(previous, { recursive: true, force: true });
if (fs.existsSync(CHROME_DIR)) fs.renameSync(CHROME_DIR, previous);
try {
  fs.renameSync(STAGING_DIR, CHROME_DIR);
  fs.rmSync(previous, { recursive: true, force: true });
} catch (err) {
  if (!fs.existsSync(CHROME_DIR) && fs.existsSync(previous)) fs.renameSync(previous, CHROME_DIR);
  console.error(`构建中止：换入 dist/chrome 失败，已恢复上一版产物。${err.message}`);
  process.exitCode = 1;
}

if (process.exitCode !== 1) console.log(`Build complete! Output: ${CHROME_DIR}\n`);
