import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { connect } from 'puppeteer-real-browser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3890;

let currentDownload = {
    isRunning: false,
    abortController: false,
    clients: new Set(),
    stats: {
        total: 0,
        current: 0,
        percent: 0,
        chapterTitle: '',
        status: 'idle',
        log: []
    }
};

let shutdownTimer = null;

function resetShutdownTimer() {
    if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = null;
    }
}

function checkAutoShutdown() {
    if (currentDownload.clients.size === 0 && !currentDownload.isRunning) {
        resetShutdownTimer();
        shutdownTimer = setTimeout(() => {
            if (currentDownload.clients.size === 0 && !currentDownload.isRunning) {
                console.log('🛑 GUI 창이 닫혀 프로그램을 완전히 종료합니다.');
                process.exit(0);
            }
        }, 6000);
    }
}

function broadcast(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of currentDownload.clients) {
        try {
            client.write(payload);
        } catch (e) {
            currentDownload.clients.delete(client);
        }
    }
}

function addLog(msg) {
    const timestamp = new Date().toLocaleTimeString();
    const logItem = `[${timestamp}] ${msg}`;
    currentDownload.stats.log.push(logItem);
    if (currentDownload.stats.log.length > 300) currentDownload.stats.log.shift();
    broadcast({ type: 'log', message: logItem });
    console.log(`[GUI-Log] ${msg}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFilename(name) {
    if (!name) return '';
    return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

function formatChapterTitle(num, rawTitle) {
    const cleanNum = parseInt(num, 10) || 0;
    const title = (rawTitle || '').trim();
    if (!title) return `${cleanNum}화`;
    if (/^(?:제\s*)?\d+\s*화/.test(title)) {
        return title;
    }
    return `${cleanNum}화  ${title}`;
}

function formatNovelFileName(title, author, genre, rangeLabel, isCompleted = false, isAllDownload = false) {
    const safeTitle = sanitizeFilename(title);
    const safeAuthor = sanitizeFilename(author);
    const safeGenre = sanitizeFilename(genre);

    let parts = [safeTitle];
    if (safeAuthor) parts.push(safeAuthor);
    if (safeGenre) parts.push(safeGenre);

    const baseName = parts.join('-');

    let tag = '';
    if (isCompleted && isAllDownload) {
        tag = '[완결]';
    } else if (rangeLabel) {
        tag = `[${rangeLabel}]`;
    }

    if (tag) {
        return `${baseName} ${tag}.txt`;
    }
    return `${baseName}.txt`;
}

function cleanNovelText(raw) {
    if (!raw) return '';
    let text = raw
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<(?:\/?(?:p|div|span|a|b|strong|i|em|u|font|img)(?:\s+[^>]*)?)>/gi, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"');

    const lines = text.split('\n').map(l => l.trim());
    let result = lines.join('\n');
    result = result.replace(/\n{3,}/g, '\n\n');
    return result.trim();
}

async function getNovelContent(page) {
    try {
        await page.waitForSelector('#novel_content, [data-theme-novel-content], .theme-novel-content', { timeout: 35000 }).catch(() => {});
        await sleep(1200);

        const content = await page.evaluate(() => {
            const host = document.querySelector('[data-theme-novel-content]') ||
                         document.querySelector('.theme-novel-content') ||
                         document.querySelector('.novel-epub-rendered')?.getRootNode()?.host ||
                         document.querySelector('#novel_content')?.getRootNode()?.host;

            if (host && host.shadowRoot) {
                const pTags = host.shadowRoot.querySelectorAll('.novel-epub-rendered p, p');
                if (pTags.length > 0) {
                    return Array.from(pTags).map(p => p.textContent.trim()).filter(t => t.length > 0).join('\n\n');
                }
                const nonStyle = Array.from(host.shadowRoot.children).filter(c => c.tagName !== 'STYLE' && c.tagName !== 'SCRIPT');
                const pTexts = nonStyle.map(c => (c.innerText || c.textContent || '').trim()).filter(t => t.length > 0);
                if (pTexts.length > 0) return pTexts.join('\n\n');
            }

            const legacy = document.querySelector('#novel_content');
            if (legacy && legacy.innerText && legacy.innerText.trim().length > 30) {
                return legacy.innerText.trim();
            }
            return '';
        });

        return cleanNovelText(content);
    } catch (e) {
        return '';
    }
}

// 소설 정보 사전 분석 (Inspect)
async function inspectNovel(targetUrl) {
    let browser = null;
    try {
        const conn = await connect({
            headless: 'auto',
            turnstile: true
        });
        browser = conn.browser;
        const page = conn.page;

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        while (true) {
            const title = await page.title();
            if (!title.includes('Just a moment') && !title.includes('Cloudflare') && title.length > 0) break;
            await sleep(500);
        }

        await page.locator('.list-body').setTimeout(30000).wait();
        await sleep(1000);

        const meta = await page.evaluate(() => {
            const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
            let title = '';
            if (ogTitle) title = ogTitle.split(' - ')[0].trim();
            else if (document.title) title = document.title.split(' - ')[0].trim();
            const pageTitle = document.querySelector('.page-title span') || document.querySelector('.page-title');
            if (pageTitle) {
                const clone = pageTitle.cloneNode(true);
                clone.querySelectorAll('.page-desc, span').forEach(e => e.remove());
                const t = clone.innerText.trim();
                if (t) title = t;
            }
            title = (title || '소설').replace(/웹소설.*$/, '').trim();

            const authorEl = document.querySelector('a[href*="author="]');
            const author = authorEl ? authorEl.innerText.trim() : '';

            let firstGenre = '';
            let isCompleted = false;
            let publishStatus = '';

            const allTextElements = Array.from(document.querySelectorAll('td, div, tr, p, span'));
            for (const el of allTextElements) {
                const t = el.innerText || '';
                if (!firstGenre && (t.startsWith('장르') || t.includes('\n장르\n') || t.includes('장르\n') || t.includes('장르 :'))) {
                    const match = t.match(/장르\s*[\n:]\s*([^\n]+)/);
                    if (match) {
                        const rawGenres = match[1].split(',');
                        if (rawGenres.length > 0 && rawGenres[0].trim()) firstGenre = rawGenres[0].trim();
                    }
                }
                if (!publishStatus && (t.includes('발행구분') || t.includes('연재상태') || t.includes('상태'))) {
                    const match = t.match(/(?:발행구분|연재상태|상태)\s*[\n:]\s*([^\n]+)/);
                    if (match) {
                        publishStatus = match[1].trim();
                        if (publishStatus.includes('완결')) isCompleted = true;
                    }
                }
            }
            if (!firstGenre) {
                const genreLink = document.querySelector('a[href*="genre="], a[href*="tag="]');
                if (genreLink) firstGenre = genreLink.innerText.trim();
            }
            if (!isCompleted) {
                const titleText = document.querySelector('.page-title')?.innerText || '';
                if (titleText.includes('완결') || document.querySelector('.badge')?.innerText.includes('완결')) isCompleted = true;
            }

            // 첫 페이지의 회차 목록 수집
            let list = Array.from(document.querySelector('.list-body').querySelectorAll('li'));
            let epList = [];
            for (let i = 0; i < list.length; i++) {
                const rawNum = list[i].querySelector('.wr-num') ? list[i].querySelector('.wr-num').innerText.trim() : '';
                const rawTitle = list[i].querySelector('a') ? list[i].querySelector('a').innerHTML.replace(/<span[\s\S]*?\/span>/g, '').trim() : '';
                const numVal = parseInt(rawNum, 10) || (i + 1);
                let finalTitle = rawTitle;
                if (!/^(?:제\s*)?\d+\s*화/.test(rawTitle)) {
                    finalTitle = `${numVal}화  ${rawTitle}`;
                }
                epList.push({
                    num: numVal,
                    title: finalTitle,
                    url: list[i].querySelector('a')?.href
                });
            }

            const hasPagination = !!document.querySelector('ul.pagination li[class="active"] ~ li:not([class="disabled"]) a');

            return {
                title,
                author,
                firstGenre,
                isCompleted,
                publishStatus: publishStatus || (isCompleted ? '완결' : '연재중'),
                episodes: epList,
                hasPagination
            };
        });

        await browser.close();
        return meta;
    } catch (e) {
        if (browser) await browser.close();
        throw e;
    }
}

// 실제 다운로드 실행 루프
async function startDownloadTask(config) {
    const { url, start = 1, last = 99999, outputDir = './북토끼' } = config;
    currentDownload.isRunning = true;
    currentDownload.abortFlag = false;
    currentDownload.stats = {
        total: 0,
        current: 0,
        percent: 0,
        chapterTitle: '',
        status: 'running',
        log: []
    };

    addLog(`🚀 다운로드 작업 시작: ${url}`);
    addLog(`범위: ${start}화 ~ ${last === 99999 ? '끝' : last + '화'}`);

    let browser = null;
    try {
        addLog('브라우저 초기화 중 (Cloudflare 우회 준비)...');
        const conn = await connect({
            headless: 'auto',
            turnstile: true
        });
        browser = conn.browser;
        const page = conn.page;

        addLog(`소설 목록 페이지 접속 중: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        while (true) {
            const title = await page.title();
            if (!title.includes('Just a moment') && !title.includes('Cloudflare') && title.length > 0) break;
            await sleep(500);
        }

        let link = [];
        let novelMeta = null;

        addLog('전체 회차 목록 탐색 중...');
        while (true) {
            if (currentDownload.abortFlag) throw new Error('사용자에 의해 중단되었습니다.');

            await page.locator('.list-body').setTimeout(40000).wait();
            await sleep(800);

            const pageLinks = await page.evaluate(() => {
                let list = Array.from(document.querySelector('.list-body').querySelectorAll('li'));
                return list.map((li, i) => {
                    const rawNum = li.querySelector('.wr-num') ? li.querySelector('.wr-num').innerText.trim() : '';
                    const rawTitle = li.querySelector('a') ? li.querySelector('a').innerHTML.replace(/<span[\s\S]*?\/span>/g, '').trim() : '';
                    const numVal = parseInt(rawNum, 10) || (i + 1);
                    let finalTitle = rawTitle;
                    if (!/^(?:제\s*)?\d+\s*화/.test(rawTitle)) {
                        finalTitle = `${numVal}화  ${rawTitle}`;
                    }
                    return {
                        num: numVal.toString().padStart(4, '0'),
                        numVal: numVal,
                        fileName: finalTitle,
                        src: li.querySelector('a')?.href
                    };
                });
            });

            link = link.concat(pageLinks);

            if (!novelMeta) {
                novelMeta = await page.evaluate(() => {
                    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
                    let title = '';
                    if (ogTitle) title = ogTitle.split(' - ')[0].trim();
                    else if (document.title) title = document.title.split(' - ')[0].trim();
                    const pageTitle = document.querySelector('.page-title span') || document.querySelector('.page-title');
                    if (pageTitle) {
                        const clone = pageTitle.cloneNode(true);
                        clone.querySelectorAll('.page-desc, span').forEach(e => e.remove());
                        const t = clone.innerText.trim();
                        if (t) title = t;
                    }
                    title = (title || '제목없음').replace(/웹소설.*$/, '').trim();

                    const authorEl = document.querySelector('a[href*="author="]');
                    const author = authorEl ? authorEl.innerText.trim() : '';

                    let firstGenre = '';
                    let isCompleted = false;
                    let publishStatus = '';

                    const allTextElements = Array.from(document.querySelectorAll('td, div, tr, p, span'));
                    for (const el of allTextElements) {
                        const t = el.innerText || '';
                        if (!firstGenre && (t.startsWith('장르') || t.includes('\n장르\n') || t.includes('장르\n') || t.includes('장르 :'))) {
                            const match = t.match(/장르\s*[\n:]\s*([^\n]+)/);
                            if (match) {
                                const rawGenres = match[1].split(',');
                                if (rawGenres.length > 0 && rawGenres[0].trim()) firstGenre = rawGenres[0].trim();
                            }
                        }
                        if (!publishStatus && (t.includes('발행구분') || t.includes('연재상태') || t.includes('상태'))) {
                            const match = t.match(/(?:발행구분|연재상태|상태)\s*[\n:]\s*([^\n]+)/);
                            if (match) {
                                publishStatus = match[1].trim();
                                if (publishStatus.includes('완결')) isCompleted = true;
                            }
                        }
                    }
                    if (!firstGenre) {
                        const genreLink = document.querySelector('a[href*="genre="], a[href*="tag="]');
                        if (genreLink) firstGenre = genreLink.innerText.trim();
                    }
                    if (!isCompleted) {
                        const titleText = document.querySelector('.page-title')?.innerText || '';
                        if (titleText.includes('완결') || document.querySelector('.badge')?.innerText.includes('완결')) isCompleted = true;
                    }

                    return { title, author, firstGenre, isCompleted, publishStatus: publishStatus || (isCompleted ? '완결' : '연재중') };
                });
            }

            if (await page.$('ul.pagination li[class="active"] ~ li:not([class="disabled"]) a')) {
                await Promise.all([
                    page.waitForNavigation(),
                    page.locator('ul.pagination li[class="active"] ~ li:not([class="disabled"]) a').click()
                ]);
            } else {
                break;
            }
        }

        link.reverse(); // 1화부터 정렬
        const rawTotalCount = link.length;

        // 범위 필터링
        const filteredLink = link.filter(ep => ep.numVal >= start && ep.numVal <= last);
        const totalCount = filteredLink.length;

        if (totalCount === 0) {
            throw new Error(`선택한 범위 (${start}화~${last}화)에 해당하는 회차가 없습니다.`);
        }

        const startNum = filteredLink[0].numVal;
        const lastNum = filteredLink[filteredLink.length - 1].numVal;
        const isAllDownload = (startNum === 1 && lastNum >= rawTotalCount);

        addLog(`소설 정보: [${novelMeta.title}] | 작가: ${novelMeta.author || '미상'} | 장르: ${novelMeta.firstGenre || '일반'} | 상태: ${novelMeta.publishStatus}`);
        addLog(`수집 대상: 총 ${totalCount}개 회차 (${startNum}화 ~ ${lastNum}화)`);

        broadcast({
            type: 'meta',
            meta: {
                ...novelMeta,
                totalEpisodes: rawTotalCount,
                targetCount: totalCount,
                startNum,
                lastNum
            }
        });

        const safeTitle = sanitizeFilename(novelMeta.title);
        const baseDir = outputDir ? path.resolve(outputDir, safeTitle) : path.resolve('./북토끼', safeTitle);
        const individualDir = path.join(baseDir, '개별화');

        if (!fs.existsSync(individualDir)) {
            fs.mkdirSync(individualDir, { recursive: true });
        }

        const collectedChapters = [];

        for (let i = 0; i < filteredLink.length; i++) {
            if (currentDownload.abortFlag) throw new Error('사용자에 의해 중단되었습니다.');

            const ep = filteredLink[i];
            const currentIdx = i + 1;
            const percent = Math.round((i / totalCount) * 100);
            const safeFileName = sanitizeFilename(ep.fileName);
            const targetFilePath = path.join(individualDir, `${ep.num} ${safeFileName}.txt`);

            currentDownload.stats.current = currentIdx;
            currentDownload.stats.total = totalCount;
            currentDownload.stats.percent = percent;
            currentDownload.stats.chapterTitle = ep.fileName;

            broadcast({
                type: 'progress',
                current: currentIdx,
                total: totalCount,
                percent: percent,
                chapterTitle: ep.fileName
            });

            addLog(`[${currentIdx}/${totalCount}] ${ep.fileName} 수집 중...`);

            let fileContent = '';
            if (fs.existsSync(targetFilePath)) {
                fileContent = fs.readFileSync(targetFilePath, 'utf8');
                addLog(`  -> 기존 파일에서 로드 (${fileContent.length}자)`);
            } else {
                await page.goto(ep.src, { waitUntil: 'domcontentloaded' });
                fileContent = await getNovelContent(page);

                if (fileContent && fileContent.length > 0) {
                    fs.writeFileSync(targetFilePath, fileContent, 'utf8');
                    addLog(`  -> 다운로드 완료 (${fileContent.length}자)`);
                } else {
                    addLog(`  ⚠️ 본문 추출 실패: ${ep.fileName}`);
                }

                // 지터 딜레이
                const jitter = 1500 + Math.random() * 1000;
                await sleep(jitter);
            }

            if (fileContent && fileContent.length > 0) {
                collectedChapters.push({
                    num: ep.numVal,
                    title: ep.fileName,
                    content: fileContent
                });
            }
        }

        // 통합 소설 텍스트 파일 생성
        if (collectedChapters.length > 0) {
            addLog('📄 통합 소설 텍스트 파일 생성 중...');
            let fullBook = '';
            collectedChapters.forEach(c => {
                fullBook += `${c.title}\n\n`;
                fullBook += `${c.content}\n\n\n`;
            });

            const rangeLabel = `${startNum}화~${lastNum}화`;
            const singleFileName = formatNovelFileName(novelMeta.title, novelMeta.author, novelMeta.firstGenre, rangeLabel, novelMeta.isCompleted, isAllDownload);
            const finalFilePath = path.join(baseDir, singleFileName);

            fs.writeFileSync(finalFilePath, fullBook, 'utf8');
            addLog(`🎉 통합 파일 생성 완료: ${finalFilePath}`);

            currentDownload.stats.percent = 100;
            currentDownload.stats.status = 'completed';

            broadcast({
                type: 'completed',
                filePath: finalFilePath,
                fileName: singleFileName,
                totalCount: collectedChapters.length
            });
        }

    } catch (err) {
        addLog(`❌ 오류 발생: ${err.message}`);
        currentDownload.stats.status = 'error';
        broadcast({ type: 'error', message: err.message });
    } finally {
        if (browser) await browser.close();
        currentDownload.isRunning = false;
    }
}

// HTTP 서버 라우팅
const server = http.createServer(async (req, res) => {
    // CORS 헤더
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // 1. SSE 진행 상황 스트림
    if (pathname === '/api/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.write('\n');
        currentDownload.clients.add(res);
        resetShutdownTimer();

        // 초기 상태 전송
        res.write(`data: ${JSON.stringify({ type: 'init', stats: currentDownload.stats })}\n\n`);

        req.on('close', () => {
            currentDownload.clients.delete(res);
            checkAutoShutdown();
        });
        return;
    }

    // 2. 소설 정보 사전 조회 (Inspect)
    if (pathname === '/api/inspect' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (!data.url) throw new Error('소설 URL을 입력해주세요.');
                addLog(`🔍 소설 정보 조회 요청: ${data.url}`);
                const meta = await inspectNovel(data.url);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, meta }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // 3. 다운로드 시작 요청 (Download)
    if (pathname === '/api/download' && req.method === 'POST') {
        if (currentDownload.isRunning) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: '이미 다운로드 작업이 진행 중입니다.' }));
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (!data.url) throw new Error('소설 URL을 입력해주세요.');
                
                // 비동기로 다운로드 태스크 시작
                startDownloadTask(data);

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, message: '다운로드가 시작되었습니다.' }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // 4. 다운로드 중단 요청 (Stop)
    if (pathname === '/api/stop' && req.method === 'POST') {
        if (currentDownload.isRunning) {
            currentDownload.abortFlag = true;
            addLog('🛑 사용자가 다운로드 중단을 요청했습니다.');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: '중단 신호를 보냈습니다.' }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: '진행 중인 작업이 없습니다.' }));
        }
        return;
    }

    // 5. 정적 웹페이지 서빙
    if (pathname === '/' || pathname === '/index.html') {
        const htmlPath = path.join(__dirname, 'public', 'index.html');
        if (fs.existsSync(htmlPath)) {
            const html = fs.readFileSync(htmlPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } else {
            res.writeHead(404);
            res.end('index.html not found');
        }
        return;
    }

    // 기타
    res.writeHead(404);
    res.end('Not Found');
});

function launchAppWindow(appUrl) {
    if (process.platform === 'win32') {
        const edgePaths = [
            `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
            `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`
        ];
        const chromePaths = [
            `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`
        ];

        let browserExe = null;
        for (const p of [...edgePaths, ...chromePaths]) {
            if (p && fs.existsSync(p)) {
                browserExe = p;
                break;
            }
        }

        if (browserExe) {
            // App Mode 실행: 주소창, 탭 바 없이 윈도우 데스크톱 앱 독립 창으로 실행
            const appCmd = `"${browserExe}" --app="${appUrl}" --window-size=720,920`;
            exec(appCmd, () => {});
            return;
        }

        exec(`start ${appUrl}`, () => {});
    } else {
        exec(`open ${appUrl}`, () => {});
    }
}

server.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Toki Novel Downloader 윈도우 데스크톱 앱 실행 완료!`);
    console.log(`==================================================\n`);

    launchAppWindow(`http://localhost:${PORT}`);
});
