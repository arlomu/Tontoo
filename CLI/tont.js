#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { exec, execSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { URLSearchParams } = require('url');
const archiver = require('archiver');
const fse = require('fs-extra');
const mysql = require('mysql2/promise');
const yaml = require('js-yaml');

// --- CONFIGURATION ---
const DEVELOPER_NAME = 'arlomu';
const DEVELOPER_WEBSITE = 'https://arlocraftmc.de';
const DEVELOPER_REPO = 'github.com/arlomu/Tontoo';
const TONTOO_VERSION = '1.9.0';
const SECRET_KEY = 'tontoo-super-secret-key-123456789012345';
const PACKAGE_REGISTRY_URL = 'https://github.com/arlomu/tontoo-packet';
const PACKAGES_DIR_NAME = 'tont-packets';
const PACKAGE_MANIFEST = 'package.yml';

// --- Encryption and decryption functions ---
function encryptData(data) {
  const key = crypto.createHash('sha256').update(SECRET_KEY).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptData(data) {
  const key = crypto.createHash('sha256').update(SECRET_KEY).digest();
  const parts = data.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = parts[1];
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// --- Main command processing ---
const args = process.argv.slice(2);
const command = args[0];
const param = args[1];

if (command === 'build') {
  buildProject(false);
} else if (command === 'dev') {
  buildProject(true);
} else if (command === 'info') {
  showInfo();
} else if (command === 'setup') {
  setupProject();
} else if (command === 'install') {
  if (!param) {
    console.error('Please use tont install <package_name>[@version] to install a package.');
    process.exit(1);
  }
  installPackage(param);
} else if (command === 'uninstall') {
  if (!param) {
    console.error('Please use tont uninstall <package_name> to uninstall a package.');
    process.exit(1);
  }
  uninstallPackage(param);
} else if (command === 'update') {
  updatePackages(param);
} else if (command && fs.existsSync(command) && command.endsWith('.tontoo')) {
  runProjectFromFile(command);
} else {
  showHelp();
}

// =================================================================
// PACKAGE MANAGEMENT LOGIC (IMPROVED)
// =================================================================

function readTontooJson() {
  const rootDir = process.cwd();
  const tontooJsonPath = path.join(rootDir, 'tontoo.json');
  if (fs.existsSync(tontooJsonPath)) {
    return JSON.parse(fs.readFileSync(tontooJsonPath, 'utf8'));
  }
  return { dependencies: {} };
}

function writeTontooJson(data) {
  const rootDir = process.cwd();
  const tontooJsonPath = path.join(rootDir, 'tontoo.json');
  fs.writeFileSync(tontooJsonPath, JSON.stringify(data, null, 2));
}

function readPackageManifest(packagePath) {
  const manifestPath = path.join(packagePath, PACKAGE_MANIFEST);
  if (fs.existsSync(manifestPath)) {
    return yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  }
  return null;
}

async function installPackage(packageSpec) {
  const [packageName, version] = packageSpec.split('@');
  const rootDir = process.cwd();
  const packagesDir = path.join(rootDir, PACKAGES_DIR_NAME);
  const packagePath = path.join(packagesDir, packageName);
  const tempDir = path.join(os.tmpdir(), `tontoo-temp-${Date.now()}`);

  if (fs.existsSync(packagePath)) {
    console.warn(`Warning: Package "${packageName}" is already installed. Use "tont update" to update.`);
    return;
  }

  console.log(`Installing package "${packageSpec}"...`);
  try {
    fs.mkdirSync(packagesDir, { recursive: true });

    // Clone the repository into a temporary directory
    const repoUrl = `${PACKAGE_REGISTRY_URL}.git`;
    console.log(`Cloning from ${repoUrl}...`);
    execSync(`git clone --depth 1 ${repoUrl} "${tempDir}"`, { stdio: 'ignore' });

    // Check if package exists and read its manifest
    const sourcePackageDir = path.join(tempDir, packageName);
    if (!fs.existsSync(sourcePackageDir)) {
      throw new Error(`Package "${packageName}" not found in registry`);
    }

    const manifest = readPackageManifest(sourcePackageDir);
    if (!manifest) {
      throw new Error(`Package manifest (${PACKAGE_MANIFEST}) not found`);
    }

    // Check version if specified
    if (version && manifest.version !== version) {
      throw new Error(`Version ${version} not found. Available version: ${manifest.version}`);
    }

    console.log(`Installing ${manifest.name}@${manifest.version}...`);
    console.log(`Description: ${manifest.description || 'No description'}`);

    // Copy package files
    fse.copySync(sourcePackageDir, packagePath, { overwrite: true });

    // Update tontoo.json
    const tontooJson = readTontooJson();
    tontooJson.dependencies[packageName] = {
      version: manifest.version,
      registry: `${PACKAGE_REGISTRY_URL}/tree/main/${packageName}`,
      installedAt: new Date().toISOString()
    };
    writeTontooJson(tontooJson);

    // Run post-install script if defined
    if (manifest.scripts && manifest.scripts.postinstall) {
      console.log('Running post-install script...');
      execSync(manifest.scripts.postinstall, { cwd: packagePath, stdio: 'inherit' });
    }

    console.log(`\nSuccessfully installed ${manifest.name}@${manifest.version}!`);
  } catch (error) {
    console.error(`\nError installing "${packageSpec}".`);
    console.error(`Details: ${error.message}`);
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exit(1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function uninstallPackage(packageName) {
  const rootDir = process.cwd();
  const packagesDir = path.join(rootDir, PACKAGES_DIR_NAME);
  const packagePath = path.join(packagesDir, packageName);

  if (!fs.existsSync(packagePath)) {
    console.warn(`Warning: Package "${packageName}" is not installed`);
    return;
  }

  // Read manifest for pre-uninstall script
  const manifest = readPackageManifest(packagePath);
  
  console.log(`Removing package "${packageName}"...`);
  try {
    // Run pre-uninstall script if defined
    if (manifest && manifest.scripts && manifest.scripts.preuninstall) {
      console.log('Running pre-uninstall script...');
      execSync(manifest.scripts.preuninstall, { cwd: packagePath, stdio: 'inherit' });
    }

    fs.rmSync(packagePath, { recursive: true, force: true });

    // Update tontoo.json
    const tontooJson = readTontooJson();
    delete tontooJson.dependencies[packageName];
    writeTontooJson(tontooJson);

    console.log(`Package "${packageName}" successfully uninstalled!`);
  } catch (error) {
    console.error(`\nError uninstalling package "${packageName}".`);
    console.error(`Details: ${error.message}`);
    process.exit(1);
  }
}

async function updatePackages(packageName = null) {
  const rootDir = process.cwd();
  const packagesDir = path.join(rootDir, PACKAGES_DIR_NAME);
  const tontooJson = readTontooJson();
  
  if (!tontooJson.dependencies || Object.keys(tontooJson.dependencies).length === 0) {
    console.log('No packages installed to update.');
    return;
  }

  const packagesToUpdate = packageName ? 
    { [packageName]: tontooJson.dependencies[packageName] } : 
    tontooJson.dependencies;

  for (const [pkgName, pkgData] of Object.entries(packagesToUpdate)) {
    try {
      const packagePath = path.join(packagesDir, pkgName);
      if (!fs.existsSync(packagePath)) {
        console.warn(`Package "${pkgName}" is not installed. Skipping...`);
        continue;
      }

      console.log(`Checking updates for ${pkgName}...`);
      const tempDir = path.join(os.tmpdir(), `tontoo-update-${Date.now()}`);
      const repoUrl = `${PACKAGE_REGISTRY_URL}.git`;

      // Clone the latest version
      execSync(`git clone --depth 1 ${repoUrl} "${tempDir}"`, { stdio: 'ignore' });

      const sourcePackageDir = path.join(tempDir, pkgName);
      if (!fs.existsSync(sourcePackageDir)) {
        console.warn(`Package "${pkgName}" not found in registry. Skipping...`);
        continue;
      }

      const manifest = readPackageManifest(sourcePackageDir);
      if (!manifest) {
        console.warn(`Package manifest not found for "${pkgName}". Skipping...`);
        continue;
      }

      if (manifest.version === pkgData.version) {
        console.log(`${pkgName} is already up to date (${pkgData.version}).`);
        continue;
      }

      console.log(`Updating ${pkgName} from ${pkgData.version} to ${manifest.version}...`);

      // Run pre-uninstall script from old version
      const oldManifest = readPackageManifest(packagePath);
      if (oldManifest && oldManifest.scripts && oldManifest.scripts.preuninstall) {
        console.log('Running pre-uninstall script for old version...');
        execSync(oldManifest.scripts.preuninstall, { cwd: packagePath, stdio: 'inherit' });
      }

      // Remove old version
      fs.rmSync(packagePath, { recursive: true, force: true });

      // Install new version
      fse.copySync(sourcePackageDir, packagePath, { overwrite: true });

      // Run post-install script for new version
      if (manifest.scripts && manifest.scripts.postinstall) {
        console.log('Running post-install script for new version...');
        execSync(manifest.scripts.postinstall, { cwd: packagePath, stdio: 'inherit' });
      }

      // Update tontoo.json
      tontooJson.dependencies[pkgName] = {
        version: manifest.version,
        registry: `${PACKAGE_REGISTRY_URL}/tree/main/${pkgName}`,
        installedAt: new Date().toISOString(),
        previousVersion: pkgData.version
      };
      writeTontooJson(tontooJson);

      console.log(`Successfully updated ${pkgName} to version ${manifest.version}!`);
    } catch (error) {
      console.error(`Error updating package "${pkgName}": ${error.message}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// =================================================================
// BUILD LOGIC
// =================================================================

function checkSyntax(code, filename) {
    const lines = code.split('\n');
    let braceCount = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('{')) braceCount++;
        if (line.includes('}')) braceCount--;

        const keywordMatch = line.trim().match(/^(\w+):/);
        if (keywordMatch) {
            const keyword = keywordMatch[1];
            const value = line.trim().substring(keyword.length + 1).trim();
            if (!value && !lines[i+1]?.trim().startsWith('{')) {
                throw new Error(`Syntax Error in ${filename} on line ${i + 1}: Keyword '${keyword}' is not followed by a value or a block.`);
            }
        }
    }
    if (braceCount !== 0) {
        throw new Error(`Syntax Error in ${filename}: Mismatched curly braces {}.`);
    }
    return true;
}

function stripComments(code) {
  return code.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
}

function buildProject(devMode = false) {
  console.log(`Starting ${devMode ? 'Development-Build' : 'Default-Build'}-process...`);

  const rootDir = process.cwd();
  const buildDir = path.join(rootDir, 'build');

  const tontooJson = readTontooJson();
  if (!tontooJson || Object.keys(tontooJson).length === 0) {
    console.error('Error: tontoo.json not found or empty. Please run "tontoo setup" to create a new project.');
    process.exit(1);
  }
  const projectName = tontooJson.name || path.basename(rootDir);

  if (!devMode && !fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
  }

  const filesToProcess = {};
  const allFiles = fs.readdirSync(rootDir, { withFileTypes: true, recursive: true });

  for (const f of allFiles) {
    const relPath = path.relative(rootDir, path.join(f.path, f.name));
    if (f.isFile() && !relPath.startsWith('build') && !relPath.startsWith(PACKAGES_DIR_NAME) && !relPath.includes('.git') && !relPath.includes('node_modules')) {
        filesToProcess[relPath] = fs.readFileSync(path.join(f.path, f.name), 'utf8');
    }
  }

  // Add package files to the build
  console.log('Adding installed packages...');
  const packagesDir = path.join(rootDir, PACKAGES_DIR_NAME);
  if (fs.existsSync(packagesDir)) {
    const packageFiles = fs.readdirSync(packagesDir, { withFileTypes: true, recursive: true });
    for (const f of packageFiles) {
        if (f.isFile()) {
            const relPath = path.relative(packagesDir, path.join(f.path, f.name));
            const fullPath = path.join(packagesDir, relPath);
            filesToProcess[path.join(PACKAGES_DIR_NAME, relPath)] = fs.readFileSync(fullPath, 'utf8');
        }
    }
  }

  if (Object.keys(filesToProcess).length === 0) {
    console.error('Error: No data found to build');
    process.exit(1);
  }

  try {
    console.log('Checking syntax...');
    for (const fileName in filesToProcess) {
        if (fileName.endsWith('.tont')) {
            checkSyntax(filesToProcess[fileName], fileName);
        }
    }
    console.log('Syntax check successful.');

    // Create the build file in memory
    const dataToCompress = JSON.stringify(filesToProcess);
    const encryptedData = encryptData(dataToCompress);
    const compressedData = zlib.gzipSync(encryptedData);

    if (devMode) {
      console.log('Build successfully started in Dev Mode...');
      runProjectFromData(compressedData, tontooJson);
    } else {
      console.log('Creating default .tontoo data...');
      const outFile = path.join(buildDir, `${projectName}.tontoo`);
      fs.writeFileSync(outFile, compressedData);
      console.log(`\nBuild successful: ${outFile}`);

      // Create build file without comments
      const filesWithoutComments = { ...filesToProcess };
      for (const fileName in filesWithoutComments) {
        if (fileName.endsWith('.tont')) {
          filesWithoutComments[fileName] = stripComments(filesWithoutComments[fileName]);
        }
      }
      const dataWithoutComments = JSON.stringify(filesWithoutComments);
      const encryptedDataWithoutComments = encryptData(dataWithoutComments);
      const compressedDataWithoutComments = zlib.gzipSync(encryptedDataWithoutComments);
      const outFileNoComments = path.join(buildDir, `${projectName}_no_comments.tontoo`);
      fs.writeFileSync(outFileNoComments, compressedDataWithoutComments);

      // Create source code ZIP archive
      console.log('Creating source code ZIP archive...');
      const outputZip = fs.createWriteStream(path.join(buildDir, `${projectName}_source.zip`));
      const archive = archiver('zip', {
        zlib: { level: 9 }
      });

      archive.pipe(outputZip);

      for(const fileName in filesToProcess) {
          archive.append(filesToProcess[fileName], { name: fileName });
      }

      archive.finalize();

      outputZip.on('close', function() {
      });

      archive.on('error', function(err) {
        throw err;
      });
    }

  } catch (error) {
    console.error(`\nBuild error.`);
    console.error(`Error: ${error.message}`);
    if (devMode) console.error('Dev mode canceled.');
    process.exit(1);
  }
}

// =================================================================
// SETUP LOGIC
// =================================================================

function setupProject() {
  const rootDir = process.cwd();
  const projectName = path.basename(rootDir);

  // Create a new tontoo.json file for dependency tracking
  const defaultTontooJson = {
    name: projectName,
    version: "1.0.0",
    main: "Main.tont",
    dependencies: {}
  };
  fs.writeFileSync(path.join(rootDir, 'tontoo.json'), JSON.stringify(defaultTontooJson, null, 2));

  const publicDir = path.join(rootDir, 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

  const sslDir = path.join(rootDir, 'ssl');
  if (!fs.existsSync(sslDir)) {
    fs.mkdirSync(sslDir);
    fs.writeFileSync(path.join(sslDir, 'readme.txt'), 'Place your server.key and server.crt files for SSL here.');
  }

  const dbDir = path.join(rootDir, 'db');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir);
    fs.writeFileSync(path.join(dbDir, 'readme.txt'), 'Database configuration and migration files go here.');
  }

  const mainTontContent = `dat: Main
type: Main

load:
{
  Console
  Database
}

VB: PORT: "8080"
VB: SSLPORT: "443"
VB: HOST: "localhost"
VB: API_BASE_URL: "/api/"

# Function to copy the web files
:start: setupFiles
copyFile
{
  "from": "index.html",
  "to": "public/index.html"
}
copyFile
{
  "from": "style.css",
  "to": "public/style.css"
}
copyFile
{
  "from": "login.html",
  "to": "public/login.html"
}
copyFile
{
  "from": "register.html",
  "to": "public/register.html"
}
copyFile
{
  "from": "api-client.js",
  "to": "public/js/api-client.js"
}
:end:

# Database configuration
mysql: "setupDB"
{
  "host": "localhost",
  "user": "root",
  "password": "",
  "database": "tontoo_db"
}

# Define an API to get all news (public)
webAPI: "getNews"
{
  "type": "get",
  "data": "news.json",
  "user": "false",
  "webserverid": "webserver1",
  "line": "/news/"
}

# Define an API to get a single news item (with ID)
webAPI: "getSingleNews"
{
  "type": "get",
  "data": "news.json",
  "user": "false",
  "webserverid": "webserver1",
  "line": "/news/$ID"
}

# Define an API to post new news (requires login)
webAPI: "postNews"
{
  "type": "post",
  "data": "news.json",
  "format": "{ "title": "$TITLE", "text": "$TEXT" }",
  "user": "true",
  "webserverid": "webserver1",
  "line": "/news/"
}

# Start the web server with SSL and API support
startWEB: /public/
{
  "port": "$PORT",
  "host": "$HOST",
  "id": "webserver1",
  "404": "404.html",
  "landing": "index.html",
  "ssl": "true",
  "sslbits": "8000",
  "sslport": "$SSLPORT",
  "api": "$API_BASE_URL",
  "user": "true"
}

console.log: "Server running on http://$HOST:$PORT and https://$HOST:$SSLPORT"`;
  fs.writeFileSync(path.join(rootDir, 'Main.tont'), mainTontContent);

  const consoleTontContent = `dat: Console\ntype: Extra\nconsole.log: "Console module loaded."`;
  fs.writeFileSync(path.join(rootDir, 'Console.tont'), consoleTontContent);

  const databaseTontContent = `dat: Database
type: Database

# Sample database functions
:start: setupDB
console.log: "Database module loaded. Configuring MySQL connection..."
:end:`;
  fs.writeFileSync(path.join(rootDir, 'Database.tont'), databaseTontContent);

  const defaultHtmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to Tontoo</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="style.css">
</head>
<body class="bg-slate-900 text-gray-100 min-h-screen flex items-center justify-center p-4">
    <div class="bg-slate-800 rounded-2xl shadow-2xl w-full max-w-2xl p-8 space-y-6 animate-fade-in">
        <h1 class="text-4xl font-extrabold text-blue-400 text-center">Welcome to Tontoo</h1>
        <p class="text-center text-lg text-gray-400">
            Your Tontoo web server is running. This page demonstrates how Tontoo handles static content and API calls.
        </p>
        <div class="flex flex-col sm:flex-row justify-center space-y-4 sm:space-y-0 sm:space-x-4">
            <a href="/login.html" class="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg transition-all duration-300 transform hover:scale-105 text-center">Login</a>
            <a href="/register.html" class="px-6 py-3 bg-green-600 hover:bg-green-700 text-white font-bold rounded-lg transition-all duration-300 transform hover:scale-105 text-center">Register</a>
            <a href="/api/news/" class="px-6 py-3 bg-gray-600 hover:bg-gray-700 text-white font-bold rounded-lg transition-all duration-300 transform hover:scale-105 text-center">View API Data (JSON)</a>
        </div>

        <hr class="border-t-2 border-gray-700 my-8">

        <div class="space-y-4">
            <h2 class="text-2xl font-bold text-gray-200 text-center">Latest News (from API)</h2>
            <div id="news-container" class="space-y-4">
                <p class="text-center text-gray-500">Loading news...</p>
            </div>
        </div>
    </div>
    <script src="/js/api-client.js"></script>
    <style>
        @keyframes fade-in {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in {
            animation: fade-in 0.8s ease-out forwards;
        }
    </style>
</body>
</html>`;
  fs.writeFileSync(path.join(publicDir, 'index.html'), defaultHtmlContent);

  const defaultCssContent = `
body {
    font-family: 'Inter', sans-serif;
}
`;
  fs.writeFileSync(path.join(publicDir, 'style.css'), defaultCssContent);

  const notFoundHtmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Not Found</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-gray-100 flex items-center justify-center min-h-screen p-4">
    <div class="bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md p-8 text-center space-y-4">
        <h1 class="text-6xl font-extrabold text-red-500">404</h1>
        <p class="text-xl text-gray-400">Page Not Found</p>
        <p class="text-gray-500">The requested resource could not be found on this Tontoo server.</p>
        <a href="/" class="inline-block px-6 py-3 mt-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg transition-all duration-300 transform hover:scale-105">Go to Homepage</a>
    </div>
</body>
</html>`;
  fs.writeFileSync(path.join(publicDir, '404.html'), notFoundHtmlContent);

  const loginHtmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-gray-100 flex items-center justify-center min-h-screen p-4">
    <div class="bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm p-8 space-y-6">
        <h1 class="text-3xl font-extrabold text-blue-400 text-center">Login to Tontoo</h1>
        <form action="/login" method="post" class="space-y-4">
            <div>
                <label for="username" class="block text-sm font-semibold text-gray-400 mb-1">Username</label>
                <input type="text" id="username" name="username" required class="w-full p-3 bg-slate-700 border border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-200">
            </div>
            <div>
                <label for="password" class="block text-sm font-semibold text-gray-400 mb-1">Password</label>
                <input type="password" id="password" name="password" required class="w-full p-3 bg-slate-700 border border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-200">
            </div>
            <button type="submit" class="w-full px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg transition-all duration-300 transform hover:scale-105">Login</button>
        </form>
    </div>
</body>
</html>`;
  fs.writeFileSync(path.join(publicDir, 'login.html'), loginHtmlContent);

  const registerHtmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Register</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-gray-100 flex items-center justify-center min-h-screen p-4">
    <div class="bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm p-8 space-y-6">
        <h1 class="text-3xl font-extrabold text-green-400 text-center">Register for Tontoo</h1>
        <form action="/register" method="post" class="space-y-4">
            <div>
                <label for="username" class="block text-sm font-semibold text-gray-400 mb-1">Username</label>
                <input type="text" id="username" name="username" required class="w-full p-3 bg-slate-700 border border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-gray-200">
            </div>
            <div>
                <label for="password" class="block text-sm font-semibold text-gray-400 mb-1">Password</label>
                <input type="password" id="password" name="password" required class="w-full p-3 bg-slate-700 border border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-gray-200">
            </div>
            <button type="submit" class="w-full px-6 py-3 bg-green-600 hover:bg-green-700 text-white font-bold rounded-lg transition-all duration-300 transform hover:scale-105">Register</button>
        </form>
    </div>
</body>
</html>`;
  fs.writeFileSync(path.join(publicDir, 'register.html'), registerHtmlContent);

  const apiClientJsContent = `document.addEventListener('DOMContentLoaded', () => {
    fetch('/api/news/')
        .then(response => response.json())
        .then(news => {
            const container = document.getElementById('news-container');
            container.innerHTML = '';
            if (Array.isArray(news) && news.length > 0) {
                news.forEach(item => {
                    const newsItem = document.createElement('div');
                    newsItem.classList.add('bg-slate-700', 'p-4', 'rounded-lg', 'shadow-md', 'border', 'border-slate-600');
                    newsItem.innerHTML = '<h3 class="text-xl font-semibold text-blue-300">' + item.title + '</h3><p class="mt-2 text-gray-300">' + item.text + '</p><small class="block mt-2 text-gray-500">Published by: ' + item.author + '</small>';
                    container.appendChild(newsItem);
                });
            } else {
                container.innerHTML = '<p class="text-center text-gray-500">No news found.</p>';
            }
        })
        .catch(error => {
            console.error('Error fetching news:', error);
            document.getElementById('news-container').innerHTML = '<p class="text-center text-red-400">Error loading news.</p>';
        });
});`;
  const jsDir = path.join(publicDir, 'js');
  if (!fs.existsSync(jsDir)) fs.mkdirSync(jsDir);
  fs.writeFileSync(path.join(jsDir, 'api-client.js'), apiClientJsContent);

  const defaultUsers = { "admin": { "passwordHash": "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8", "uuid": "f47ac10b-58cc-4372-a567-0e02b2c3d479" } }; // pw is 'password'
  fs.writeFileSync(path.join(rootDir, 'users.json'), JSON.stringify(defaultUsers, null, 2));

  const defaultNews = [{ "id": 1, "title": "Welcome!", "text": "This is an example of a news item from the API.", "author": "system" }];
  fs.writeFileSync(path.join(rootDir, 'news.json'), JSON.stringify(defaultNews, null, 2));

  console.log(`\nProject setup complete! Default user is 'admin' with password 'password'.`);
}

// =================================================================
// RUNTIME LOGIC (WITH MYSQL SUPPORT)
// =================================================================

function runProjectFromFile(tontooFile) {
  try {
    const compressedData = fs.readFileSync(tontooFile);
    runProjectFromData(compressedData);
  } catch (e) {
    console.error(`Error: Could not read or decrypt project file: ${e.message}`);
    process.exit(1);
  }
}

function runProjectFromData(compressedData, tontooConfigOverride = null) {
  let variables = {};
  let functions = {};
  let webservers = {};
  let apis = {};
  let mysqlConnections = {};
  let scheduleTasks = [];
  const loadedFiles = new Set();
  let zipEntries = {};
  let processKeptAlive = false;

  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tontoo-run-'));

  const cleanup = () => {
    console.log('Tontoo runtime ended. Cleaning up...');
    // Close all MySQL connections
    Object.values(mysqlConnections).forEach(conn => {
      conn.end().catch(e => console.error('Error closing MySQL connection:', e.message));
    });
    fs.rmSync(workingDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  function keepProcessAlive() {
    if (!processKeptAlive) {
      console.log('The process is being kept alive as a web server or scheduler is running. Terminate with CTRL+C.');
      setInterval(() => {}, 1 << 30);
      processKeptAlive = true;
    }
  }

  function parseValue(val) {
    if (typeof val !== 'string') return val;
    return val.replace(/\$([A-Z0-9_]+)/g, (_, v) => variables[v] || '');
  }

  function log(msg) {
    console.log(parseValue(msg));
  }

  function copyFile(from, to) {
    const fromPath = zipEntries[from] ? path.join(workingDir, from) : from;
    const toPath = path.join(workingDir, parseValue(to));
    try {
        fs.mkdirSync(path.dirname(toPath), { recursive: true });
        fs.copyFileSync(fromPath, toPath);
    } catch (e) {
      console.error(`Error: Could not copy file from "${from}" to "${to}": ${e.message}`);
    }
  }

  function deleteFile(file) {
    const filePath = path.join(workingDir, parseValue(file));
    try { fs.unlinkSync(filePath); } catch (e) { console.error(`Error: Could not delete file "${file}": ${e.message}`); }
  }

  function deleteFolder(folder) {
    const folderPath = path.join(workingDir, parseValue(folder));
    try { fs.rmSync(folderPath, { recursive: true, force: true }); } catch (e) { console.error(`Error: Could not delete folder "${folder}": ${e.message}`); }
  }

  function moveFile(from, to) {
    const fromPath = path.join(workingDir, parseValue(from));
    const toPath = path.join(workingDir, parseValue(to));
    try { fs.renameSync(fromPath, toPath); } catch (e) { console.error(`Error: Could not move file from "${from}" to "${to}": ${e.message}`); }
  }

  function addFolder(folder) {
    const parsedFolder = path.join(workingDir, parseValue(folder));
    if (!fs.existsSync(parsedFolder)) fs.mkdirSync(parsedFolder, { recursive: true });
  }

  function addFile(file) {
    const parsedFile = path.join(workingDir, parseValue(file));
    if (!fs.existsSync(parsedFile)) fs.writeFileSync(parsedFile, '');
  }

  function editFile(file, content) {
    fs.writeFileSync(path.join(workingDir, parseValue(file)), parseValue(content));
  }

  function runCmd(cmd, wait = false) {
    const parsedCmd = parseValue(cmd);
    try {
      if (wait) { execSync(parsedCmd, { cwd: workingDir, stdio: 'inherit' }); }
      else { exec(parsedCmd, { cwd: workingDir }); }
    } catch (e) { console.error(`Error: Command failed "${parsedCmd}": ${e.message}`); }
  }

  async function setupMySQLConnection(id, config) {
    try {
      const connection = await mysql.createConnection({
        host: parseValue(config.host),
        user: parseValue(config.user),
        password: parseValue(config.password),
        database: parseValue(config.database)
      });
      
      mysqlConnections[id] = connection;
      console.log(`MySQL connection "${id}" established successfully.`);
      
      // Add query function to variables
      variables[`${id}_query`] = async (sql, params = []) => {
        try {
          const [rows] = await connection.query(sql, params);
          return rows;
        } catch (e) {
          console.error(`MySQL query error: ${e.message}`);
          throw e;
        }
      };
    } catch (e) {
      console.error(`Error creating MySQL connection "${id}": ${e.message}`);
    }
  }

  function generateSslCert(sslDir, bits) {
    const keyPath = path.join(sslDir, 'server.key');
    const certPath = path.join(sslDir, 'server.crt');

    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        console.log("SSL certificate already exists. Skipping generation.");
        return;
    }

    console.log(`Generating a new self-signed SSL certificate with ${bits}-bit key...`);
    try {
        execSync(`openssl req -x509 -newkey rsa:${bits} -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost"`, { stdio: 'inherit' });
        console.log("SSL certificate successfully generated.");
    } catch (e) {
        console.error(`Error generating SSL certificate: ${e.message}`);
    }
  }

  function startWeb(id, config) {
    const port = parseInt(parseValue(config.port || '8080'));
    const host = parseValue(config.host || 'localhost');
    const publicDir = path.join(workingDir, parseValue(config.path || 'public'));
    const landing = parseValue(config.landing || 'index.html');
    const notFoundPage = parseValue(config['404'] || '404.html');
    const apiBase = parseValue(config.api || '/api/');
    const serverApis = apis[id] || [];

    const useSsl = config.ssl === 'true';
    const useUserAuth = config.user === 'true';

    let users = {};
    let sessions = {};
    if (useUserAuth) {
        const usersPath = path.join(workingDir, 'users.json');
        if (fs.existsSync(usersPath)) {
            users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        } else {
            console.error(`Error for web server '${id}': User authentication enabled but users.json not found.`);
        }
    }

    const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

    const requestHandler = (req, res) => {
        const reqUrl = new URL(req.url, `http://${req.headers.host}`);
        const pathname = reqUrl.pathname;

        let body = [];
        req.on('data', chunk => body.push(chunk)).on('end', () => {
            body = Buffer.concat(body).toString();

            if (useUserAuth) {
                const params = new URLSearchParams(body);
                const username = params.get('username');
                const password = params.get('password');
                const passwordHash = password ? crypto.createHash('sha256').update(password).digest('hex') : null;

                if (pathname === '/login' && req.method === 'POST') {
                    if (users[username]?.passwordHash === passwordHash) {
                        const sessionId = crypto.randomUUID();
                        sessions[sessionId] = { uuid: users[username].uuid, username };
                        res.setHeader('Set-Cookie', `sessionId=${sessionId}; HttpOnly; Path=/; Max-Age=86400`);
                        res.writeHead(302, { 'Location': '/' }).end();
                    } else {
                        res.writeHead(401, { 'Content-Type': 'text/html' }).end('<h1>401 Unauthorized</h1><p>Incorrect username or password. <a href="/login.html">Try again</a>.</p>');
                    }
                    return;
                }

                if (pathname === '/register' && req.method === 'POST') {
                    if (users[username]) {
                        res.writeHead(409, { 'Content-Type': 'text/html' }).end('<h1>409 Conflict</h1><p>Username already exists. <a href="/register.html">Choose another</a>.</p>');
                        return;
                    }
                    if (username && passwordHash) {
                        users[username] = { passwordHash, uuid: crypto.randomUUID() };
                        fs.writeFileSync(path.join(workingDir, 'users.json'), JSON.stringify(users, null, 2));
                        res.writeHead(302, { 'Location': '/login.html' }).end();
                    } else {
                        res.writeHead(400, { 'Content-Type': 'text/html' }).end('<h1>400 Bad Request</h1><p>Invalid username or password.</p>');
                    }
                    return;
                }
            }

            if (pathname.startsWith(apiBase)) {
                // Dynamic API route matching, e.g., /api/news/5
                const apiPath = pathname.substring(apiBase.length - 1).replace(/\/$/, '');
                const pathSegments = apiPath.split('/');
                const dynamicPath = pathSegments.slice(0, -1).join('/') + '/$ID';
                const idFromUrl = pathSegments[pathSegments.length - 1];

                const matchingApi = serverApis.find(api => {
                    const apiLine = api.line.replace(/\/$/, '');
                    return (apiLine === apiPath || apiLine === dynamicPath) && api.type.toUpperCase() === req.method;
                });

                if (matchingApi) {
                    if (matchingApi.user === 'true') {
                        const cookies = req.headers.cookie?.split('; ').reduce((acc, c) => { const [k,v]=c.split('='); acc[k]=v; return acc; }, {}) || {};
                        const userSession = sessions[cookies.sessionId];
                        if (!userSession) {
                            res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Forbidden' }));
                            return;
                        }
                        req.user = userSession;
                    }

                    try {
                        const dataPath = path.join(workingDir, parseValue(matchingApi.data));
                        let dataFileContent = fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, 'utf8')) : [];

                        if (req.method === 'POST') {
                            const newEntry = JSON.parse(body);
                            newEntry.id = dataFileContent.length > 0 ? Math.max(...dataFileContent.map(d => d.id)) + 1 : 1;
                            if (req.user) newEntry.author = req.user.uuid;
                            dataFileContent.push(newEntry);
                            fs.writeFileSync(dataPath, JSON.stringify(dataFileContent, null, 2));
                            res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify(newEntry));
                        } else {
                            // GET logic that also supports dynamic paths
                            const queryId = idFromUrl.match(/^\d+$/) ? idFromUrl : null;
                            const result = queryId ? dataFileContent.find(d => d.id == queryId) : dataFileContent;
                            if (result) {
                                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
                            } else {
                                res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
                            }
                        }
                    } catch (e) {
                        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `Server error: ${e.message}`}));
                    }
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'API endpoint not found.' }));
                }
                return;
            }

            let filePath = path.join(publicDir, pathname === '/' ? landing : pathname);
            fs.access(filePath, fs.constants.F_OK, (err) => {
                if (err) {
                    filePath = path.join(publicDir, notFoundPage);
                }
                const ext = path.extname(filePath);
                res.writeHead(err ? 404 : 200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
                fs.createReadStream(filePath).pipe(res);
            });
        });
    };

    const httpServer = http.createServer(requestHandler).listen(port, host, () => {
        webservers[id] = { status: 1, server: httpServer, config };
        keepProcessAlive();
    }).on('error', (e) => console.error(`HTTP server error: ${e.message}`));

    if (useSsl) {
        const sslDir = path.join(workingDir, 'ssl');
        const bits = parseInt(config.sslbits || '8000');

        if (!fs.existsSync(sslDir)) fs.mkdirSync(sslDir);

        generateSslCert(sslDir, bits);

        try {
            const sslOptions = {
                key: fs.readFileSync(path.join(sslDir, 'server.key')),
                cert: fs.readFileSync(path.join(sslDir, 'server.crt')),
            };
            const sslport = parseInt(parseValue(config.sslport || '443'));
            https.createServer(sslOptions, requestHandler).listen(sslport, host, () => {
                keepProcessAlive();
            }).on('error', (e) => console.error(`HTTPS server error: ${e.message}. Are /ssl/server.key and .crt set up?`));
        } catch (e) {
            console.warn(`Could not start HTTPS server: ${e.message}. Are /ssl/server.key and .crt set up?`);
        }
    }
  }

  function checkWeb(id) { return webservers[id] ? webservers[id].status : 2; }
  function schedule(sec, fnName) { setInterval(() => functions[fnName]?.(), sec * 1000); }

  function parseCode(code, currentFilePath) {
    if (loadedFiles.has(currentFilePath)) return;
    loadedFiles.add(currentFilePath);

    const lines = code.split('\n');
    let inFunction = false;
    let currentFunction = null;
    let functionBuffer = [];
    let i = 0;

    while (i < lines.length) {
      let line = lines[i].trim();
      if (!line || line.startsWith('#')) {
          i++;
          continue;
      }

      const startFnMatch = line.match(/^:start:\s*"([^"]+)"/);
      if (startFnMatch) {
          const fnName = startFnMatch[1];
          const fn = () => {
            if(functions[fnName]) functions[fnName]();
            else console.error(`Error: Function "${fnName}" was not found for direct execution.`);
          }
          if (inFunction) functionBuffer.push(fn); else fn();
          i++;
          continue;
      }

      if (line.startsWith('VB:')) { const parts=line.substring(3).trim().split(':'); if(parts.length>=2){const key=parts[0].trim();const val=parts.slice(1).join(':').trim().replace(/^"|"$/g,'');if(key)variables[key]=val;} i++; continue; }
      if (line.startsWith(':start:')) { inFunction=true; currentFunction=line.split(' ')[1]; functionBuffer=[]; i++; continue; }
      if (line.startsWith(':end:')) { if(inFunction&&currentFunction){functions[currentFunction]=()=>{functionBuffer.forEach(cmd=>cmd());};} inFunction=false; currentFunction=null; functionBuffer=[]; i++; continue; }
      if (line.startsWith('copyFile')) { let c={}; i++; while(i<lines.length&&!lines[i].trim().startsWith('}')){ const l=lines[i].trim(); if(l.includes(':')){const[k,v]=l.split(':').map(p=>p.replace(/"|,|#/g,'').trim());c[k]=v;} i++; } const fn=()=>copyFile(c.from,c.to); if(inFunction)functionBuffer.push(fn); else fn(); i++; continue; }
      if (line.startsWith('console.log:')) { const msg=line.substring(line.indexOf(':')+1).trim().replace(/^"|"$/g,''); const fn=()=>log(msg); if(inFunction)functionBuffer.push(fn); else fn(); i++; continue; }
      if (line.startsWith('run:')) { const cmd=line.substring(line.indexOf(':')+1).trim(); let wait=false; if(lines[i+1]?.includes('"wait"')){ wait=lines[i+1].includes('"true"'); i+=2; } const fn=()=>runCmd(cmd,wait); if(inFunction)functionBuffer.push(fn); else fn(); i++; continue; }

      if (line.startsWith('mysql:')) {
          const connId = line.split(':')[1].trim().replace(/"/g, '');
          let config = {};
          i++;
          while (i < lines.length && !lines[i].trim().startsWith('}')) {
              const l = lines[i].trim();
              if (l.includes(':')) {
                  const parts = l.split(':');
                  const k = parts[0].replace(/"|,|#/g, '').trim();
                  const v = parts.slice(1).join(':').replace(/"|,|#/g, '').trim();
                  config[k] = v;
              }
              i++;
          }
          const fn = () => setupMySQLConnection(connId, config);
          if (inFunction) functionBuffer.push(fn); else fn();
          i++;
          continue;
      }

      if (line.startsWith('webAPI:')) {
          const apiName = line.split(':')[1].trim().replace(/"/g, '');
          let config = { name: apiName };
          i++;
          while (i < lines.length && !lines[i].trim().startsWith('}')) {
              const l = lines[i].trim();
              if (l.includes(':')) {
                  const parts = l.split(':');
                  const k = parts[0].replace(/"|,|#/g, '').trim();
                  const v = parts.slice(1).join(':').replace(/"|,|#/g, '').trim();
                  config[k] = v;
              }
              i++;
          }
          const webserverid = config.webserverid;
          if (webserverid) {
              if (!apis[webserverid]) apis[webserverid] = [];
              apis[webserverid].push(config);
          } else {
              console.error(`Error: webAPI "${apiName}" has no 'webserverid'.`);
          }
          i++;
          continue;
      }

      if (line.startsWith('startWEB:')) {
        let config = { };
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('}')) {
          const l = lines[i].trim();
          if (l.includes(':')) {
            const parts = l.split(':');
            const k = parts[0].replace(/"|,|#/g, '').trim();
            const v = parts.slice(1).join(':').replace(/"|,|#/g, '').trim();
            config[k] = v;
          }
          i++;
        }
        const id = config.id || 'webserver1';
        const fn = () => startWeb(id, config);
        if (inFunction) functionBuffer.push(fn); else fn();
        i++;
        continue;
      }

      if (line.startsWith('load:')) {
        i++;
        // Check if the next line is an opening curly brace
        if (lines[i]?.trim() === '{') {
          i++;
          while (i < lines.length && !lines[i].trim().startsWith('}')) {
              const packageOrFileName = lines[i].trim().replace(/"/g, '');
              if (packageOrFileName) {
                  // Check if it is a package in the 'tont-packets' directory
                  const packagePathPrefix = `${PACKAGES_DIR_NAME}/${packageOrFileName}/`;
                  let isPackageLoaded = false;
                  for (const filePath in zipEntries) {
                      if (filePath.startsWith(packagePathPrefix) && filePath.endsWith('.tont')) {
                          console.log(`Loading package file: ${filePath}`);
                          parseCode(zipEntries[filePath], filePath);
                          isPackageLoaded = true;
                      }
                  }

                  // If not found as a package, try to load it as a single file from the root
                  if (!isPackageLoaded) {
                      const fileToLoad = `${packageOrFileName}.tont`;
                      if (zipEntries[fileToLoad]) {
                          console.log(`Loading single file: ${fileToLoad}`);
                          parseCode(zipEntries[fileToLoad], fileToLoad);
                      } else {
                          console.error(`Error: Could not find file or package "${packageOrFileName}".`);
                      }
                  }
              }
              i++;
          }
          i++; // Skip the closing curly brace
        } else {
            console.error(`Error: 'load:' must be followed by a block { ... }. Error in '${currentFilePath}' line ${i}.`);
            i++;
        }
        continue;
      }
      i++;
    }
  }

  try {
    const encryptedData = zlib.gunzipSync(compressedData).toString('utf8');
    const decryptedData = decryptData(encryptedData);
    const allFiles = JSON.parse(decryptedData);

    for (const relPath in allFiles) {
        const fullPath = path.join(workingDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, allFiles[relPath]);
        if(relPath.endsWith('.tont')) {
          zipEntries[relPath] = allFiles[relPath];
        }
    }

  } catch (e) {
    console.error(`Error: Could not read or decrypt project file: ${e.message}`);
    process.exit(1);
    return;
  }

  let mainFileName = 'Main.tont';
  // If a tontoo.json configuration is passed in dev mode, use it
  if (tontooConfigOverride && tontooConfigOverride.main) {
      mainFileName = tontooConfigOverride.main;
  } else {
      const tontooJsonPath = path.join(workingDir, 'tontoo.json');
      if (fs.existsSync(tontooJsonPath)) {
          const tontooConfig = JSON.parse(fs.readFileSync(tontooJsonPath, 'utf8'));
          if (tontooConfig.main) mainFileName = tontooConfig.main;
      } else {
          console.warn('Warning: tontoo.json not found. Using Main.tont as fallback.');
      }
  }

  if (zipEntries[mainFileName]) {
    parseCode(zipEntries[mainFileName], mainFileName);
    scheduleTasks.forEach(fn => fn());
    console.log('\nAll tasks scheduled. Waiting for completion...');
    if (!processKeptAlive) {
        console.log('No long-running tasks found (e.g., web server). The process will terminate in 1 second.');
        setTimeout(() => cleanup(), 1000);
    }
  } else {
    console.error(`Error: Main file '${mainFileName}' was not found in the archive.`);
    cleanup();
  }
}

// =================================================================
// HELPER FUNCTIONS
// =================================================================

function showHelp() {
  console.log(`

  Tontoo Code

  Commands:
  tontoo <file.tontoo>      Run a Tontoo project file
  tontoo build              Build the current project
  tontoo setup              Create a new Tontoo project
  tontoo dev                Run in development mode
  tontoo info               Show version information
  tontoo install <package>  Install a package
  tontoo uninstall <package> Uninstall a package
  tontoo update [package]   Update all or specific packages
  `);
}

function showInfo() {
  console.log(`
  Tontoo Code - Info
  ---------------------
  Version:    ${TONTOO_VERSION}
  Developer:  ${DEVELOPER_NAME}
  Website:    ${DEVELOPER_WEBSITE}
  Repo:       ${DEVELOPER_REPO}
  `);
}