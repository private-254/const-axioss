const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const settings = require('../settings');
const isOwnerOrSudo = require('../lib/isOwner');

function run(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || stdout || err.message || '').toString()));
            resolve((stdout || '').toString());
        });
    });
}

let progressMsg = null;

async function updateProgress(sock, chatId, message, text) {
    try {
        if (progressMsg) {
            await sock.sendMessage(chatId, { 
                text: text,
                edit: progressMsg.key 
            });
        } else {
            const sent = await sock.sendMessage(chatId, { text: text }, { quoted: message });
            progressMsg = sent;
        }
    } catch (e) {
        console.log('Progress update failed:', e);
    }
}

async function hasGitRepo() {
    const gitDir = path.join(process.cwd(), '.git');
    if (!fs.existsSync(gitDir)) return false;
    try {
        await run('git --version');
        return true;
    } catch {
        return false;
    }
}

async function updateViaGit(sock, chatId, message) {
    await updateProgress(sock, chatId, message, '📦 Git: Fetching repository...');

    const oldRev = (await run('git rev-parse HEAD').catch(() => 'unknown')).trim();
    await updateProgress(sock, chatId, message, `📌 Current: ${oldRev.substring(0, 7)}`);

    await run('git fetch --all --prune');
    await updateProgress(sock, chatId, message, '🔍 Checking for updates...');

    const newRev = (await run('git rev-parse origin/main')).trim();
    const alreadyUpToDate = oldRev === newRev;

    if (alreadyUpToDate) {
        await updateProgress(sock, chatId, message, `✅ Already up to date: ${newRev.substring(0, 7)}`);
        return { oldRev, newRev, alreadyUpToDate, commits: '', files: '' };
    }

    await updateProgress(sock, chatId, message, `🆕 New version: ${newRev.substring(0, 7)}`);

    const commits = await run(`git log --pretty=format:"%h %s" ${oldRev}..${newRev}`).catch(() => '');
    const files = await run(`git diff --name-status ${oldRev} ${newRev}`).catch(() => '');
    const fileCount = files.split('\n').filter(f => f.trim()).length;

    await updateProgress(sock, chatId, message, `📁 Updating ${fileCount} files...`);

    await run(`git reset --hard ${newRev}`);
    await run('git clean -fd');

    return { oldRev, newRev, alreadyUpToDate, commits, files };
}

// 🔥 FULLY FIXED: Public repo download with cache buster
function downloadFile(url, dest, sock, chatId, message, visited = new Set()) {
    return new Promise((resolve, reject) => {
        try {
            if (visited.has(url) || visited.size > 5) {
                return reject(new Error('Too many redirects'));
            }
            visited.add(url);

            updateProgress(sock, chatId, message, '⬇️ Downloading update...');

            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/zip, application/octet-stream, */*',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive'
            };

            const useHttps = url.startsWith('https://');
            const client = useHttps ? require('https') : require('http');
            
            const req = client.get(url, { 
                headers: headers,
                rejectUnauthorized: false,
                timeout: 120000 // 2 minute timeout
            }, res => {
                // Handle redirects
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    const location = res.headers.location;
                    if (!location) return reject(new Error(`HTTP ${res.statusCode} without Location`));
                    const nextUrl = new URL(location, url).toString();
                    res.resume();
                    return downloadFile(nextUrl, dest, sock, chatId, message, visited).then(resolve).catch(reject);
                }

                // Check for successful response
                if (res.statusCode !== 200) {
                    let errorMsg = `❌ HTTP ${res.statusCode}`;
                    if (res.statusCode === 404) {
                        errorMsg += ' - File not found. Check URL and branch name.';
                    } else if (res.statusCode === 403) {
                        errorMsg += ' - Access forbidden. Make sure repo is public.';
                    } else if (res.statusCode === 429) {
                        errorMsg += ' - Rate limited. Try again in a few minutes.';
                    }
                    return reject(new Error(errorMsg));
                }

                const totalSize = parseInt(res.headers['content-length'], 10);
                let downloadedSize = 0;
                let lastPercent = 0;

                // Ensure directory exists
                const dir = path.dirname(dest);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                const file = fs.createWriteStream(dest);

                res.on('data', chunk => {
                    downloadedSize += chunk.length;
                    if (totalSize && totalSize > 0) {
                        const percent = Math.min(Math.round((downloadedSize / totalSize) * 100), 100);
                        if (percent >= lastPercent + 10) {
                            lastPercent = percent;
                            updateProgress(sock, chatId, message, `⬇️ Downloading: ${percent}% (${(downloadedSize/1024/1024).toFixed(1)}MB)`);
                        }
                    } else {
                        // If no content-length, show size in MB
                        const mb = (downloadedSize/1024/1024).toFixed(1);
                        if (Math.floor(downloadedSize/1024/1024) > Math.floor((downloadedSize - chunk.length)/1024/1024)) {
                            updateProgress(sock, chatId, message, `⬇️ Downloading: ${mb}MB`);
                        }
                    }
                });

                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    updateProgress(sock, chatId, message, '✅ Download complete');
                    resolve();
                });
                file.on('error', err => {
                    try { file.close(() => {}); } catch {}
                    fs.unlink(dest, () => reject(new Error(`File write error: ${err.message}`)));
                });
            });
            
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('⏰ Download timeout (120s)'));
            });
            
            req.on('error', err => {
                console.error('Download error:', err);
                fs.unlink(dest, () => reject(new Error(`🌐 Network error: ${err.message}`)));
            });
            
        } catch (e) {
            reject(e);
        }
    });
}

async function extractZip(zipPath, outDir, sock, chatId, message) {
    await updateProgress(sock, chatId, message, '📂 Extracting files...');

    if (process.platform === 'win32') {
        const cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir.replace(/\\/g, '/')}' -Force"`;
        await run(cmd);
        return;
    }

    try {
        await run('command -v unzip');
        await run(`unzip -o '${zipPath}' -d '${outDir}'`);
        return;
    } catch {}
    try {
        await run('command -v 7z');
        await run(`7z x -y '${zipPath}' -o'${outDir}'`);
        return;
    } catch {}
    try {
        await run('busybox unzip -h');
        await run(`busybox unzip -o '${zipPath}' -d '${outDir}'`);
        return;
    } catch {}
    throw new Error("❌ No unzip tool found. Install unzip, 7z, or busybox.");
}

function copyRecursive(src, dest, ignore = [], relative = '', outList = []) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    for (const entry of fs.readdirSync(src)) {
        if (ignore.includes(entry)) continue;
        const s = path.join(src, entry);
        const d = path.join(dest, entry);
        const stat = fs.lstatSync(s);

        if (stat.isDirectory()) {
            copyRecursive(s, d, ignore, path.join(relative, entry), outList);
        } else {
            fs.copyFileSync(s, d);
            outList.push(path.join(relative, entry).replace(/\\/g, '/'));
        }
    }
    return outList;
}

async function updateViaZip(sock, chatId, message, zipOverride) {
    await updateProgress(sock, chatId, message, '🗜️ Starting ZIP update...');

    let zipUrl = (zipOverride || settings.updateZipUrl || process.env.UPDATE_ZIP_URL || '').trim();
    
    // 🔥 ADD CACHE BUSTER to avoid GitHub rate limiting
    if (zipUrl && zipUrl.includes('github.com')) {
        const separator = zipUrl.includes('?') ? '&' : '?';
        zipUrl += `${separator}t=${Date.now()}`;
    }
    
    if (!zipUrl) {
        throw new Error('❌ No ZIP URL configured in settings');
    }

    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const zipPath = path.join(tmpDir, 'update.zip');
    await downloadFile(zipUrl, zipPath, sock, chatId, message);

    const extractTo = path.join(tmpDir, 'update_extract');
    if (fs.existsSync(extractTo)) fs.rmSync(extractTo, { recursive: true, force: true });

    await extractZip(zipPath, extractTo, sock, chatId, message);
    await updateProgress(sock, chatId, message, '📋 Copying files...');

    // Find the root folder in the extracted zip
    const items = fs.readdirSync(extractTo).filter(n => !n.startsWith('.'));
    let srcRoot = extractTo;
    
    // If there's exactly one folder in the root, assume it's the project root
    if (items.length === 1) {
        const singleItem = path.join(extractTo, items[0]);
        if (fs.lstatSync(singleItem).isDirectory()) {
            srcRoot = singleItem;
        }
    }

    const ignore = ['node_modules', '.git', 'session', 'tmp', 'temp', 'data', 'baileys_store.json', '.env'];
    const copied = [];

    // Preserve owner settings
    let preservedOwner = null;
    let preservedBotOwner = null;
    try {
        const currentSettings = require('../settings');
        preservedOwner = currentSettings && currentSettings.ownerNumber ? String(currentSettings.ownerNumber) : null;
        preservedBotOwner = currentSettings && currentSettings.botOwner ? String(currentSettings.botOwner) : null;
    } catch {}

    copyRecursive(srcRoot, process.cwd(), ignore, '', copied);

    // Restore preserved settings
    if (preservedOwner) {
        try {
            const settingsPath = path.join(process.cwd(), 'settings.js');
            if (fs.existsSync(settingsPath)) {
                let text = fs.readFileSync(settingsPath, 'utf8');
                text = text.replace(/ownerNumber:\s*'[^']*'/, `ownerNumber: '${preservedOwner}'`);
                if (preservedBotOwner) {
                    text = text.replace(/botOwner:\s*'[^']*'/, `botOwner: '${preservedBotOwner}'`);
                }
                fs.writeFileSync(settingsPath, text);
            }
        } catch {}
    }

    // Cleanup
    try { fs.rmSync(extractTo, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(zipPath, { force: true }); } catch {}

    return { copiedFiles: copied };
}

async function restartProcess(sock, chatId, message) {
    await updateProgress(sock, chatId, message, '♻️ Restarting bot...');

    try {
        await run('pm2 restart all');
        return;
    } catch {}
    
    try {
        await run('npm run restart');
        return;
    } catch {}

    setTimeout(() => {
        process.exit(0);
    }, 500);
}

async function updateCommand(sock, chatId, message, zipOverride) {
    const senderId = message.key.participant || message.key.remoteJid;
    const isOwner = await isOwnerOrSudo(senderId, sock, chatId);

    if (!message.key.fromMe && !isOwner) {
        await sock.sendMessage(chatId, { 
            text: '❌ *Access Denied*\nOnly the bot owner can use the update command.'
        }, { quoted: message });
        return;
    }

    const startTime = Date.now();
    progressMsg = null;

    try {
        await updateProgress(sock, chatId, message, '🔄 *Starting update...*\nPlease wait...');

        if (await hasGitRepo()) {
            const { oldRev, newRev, alreadyUpToDate } = await updateViaGit(sock, chatId, message);

            if (alreadyUpToDate) {
                await updateProgress(sock, chatId, message, `✅ *Already up to date*\n📌 ${newRev.substring(0, 7)}`);
                progressMsg = null;
                return;
            }

            await updateProgress(sock, chatId, message, '📦 Installing dependencies...');
            await run('npm install --no-audit --no-fund --silent');

        } else {
            await updateProgress(sock, chatId, message, '⚡ Using ZIP mode...');
            await updateViaZip(sock, chatId, message, zipOverride);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        try {
            const v = require('../settings').version || 'unknown';
            await updateProgress(sock, chatId, message, 
                `✅ *Update complete!*\n⏱️ ${elapsed}s\n📦 v${v}\n♻️ Restarting...`);
        } catch {
            await updateProgress(sock, chatId, message, 
                `✅ *Update complete!*\n⏱️ ${elapsed}s\n♻️ Restarting...`);
        }

        await restartProcess(sock, chatId, message);

    } catch (err) {
        console.error('Update failed:', err);
        await updateProgress(sock, chatId, message, `❌ *Update failed*\n${err.message.substring(0, 100)}`);
        progressMsg = null;
    }
}

module.exports = updateCommand;