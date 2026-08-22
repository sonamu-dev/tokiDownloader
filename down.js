import { connect } from "puppeteer-real-browser";
import fs from 'node:fs';
import { EpubBuilder } from './epub.js';

let info = {
    url: '',
    protocolDomain: 'https://booktoki350.com',
    siteTitle: '북토끼',
    site: 'booktoki',
    startIndex: 0,
    lastIndex: 99999,
    contentTitle: '소설',
    outputDir: '',
    singleFile: true, // 통합 텍스트 파일(목차 포함) 기본 생성
    makeEpub: false,  // EPUB 전자책 파일 생성 옵션
    safeCooldown: true, // 150화마다 60초 쿨다운 및 캡차 감지 자동 대기
    headless: false
}

function sleep(ms) {
    return new Promise(function (resolve) {
        setTimeout(() => { resolve(); }, ms);
    })
}
function consoleRed(val) {
    console.log(`\x1b[41m${val}\x1b[0m`);
}
function consoleGrey(val) {
    console.log(`\x1b[100m${val}\x1b[0m`);
}
function help() {
    console.log(`사용법: node down -url "URL" [-start STARTINDEX] [-last LASTINDEX] [-out "경로"] [-split]`);
    console.log(`  -url   : 소설/웹툰 목록 페이지 URL (예: https://newtoki1.org/novel/63587)`);
    console.log(`  -start : 시작 회차 번호 (기본값: 1)`);
    console.log(`  -last  : 끝 회차 번호 (기본값: 마지막)`);
    console.log(`  -out   : 다운로드 저장 폴더 경로 지정`);
    console.log(`  -split : 통합 파일 대신 화별 분할 파일로만 저장`);
    process.exit();
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

function analyseArguments() {
    let argL = process.argv.length;
    if (argL == 2) {
        help();
    }
    for (let i = 2; i < argL; i++) {
        if (process.argv[i] == '-url') {
            if ((i + 1) < argL) {
                info.url = process.argv[i + 1];
                i++;
            }
        }
        else if (process.argv[i] == '-start') {
            if ((i + 1) < argL) {
                info.startIndex = parseInt(process.argv[i + 1]);
                i++;
            }
        }
        else if (process.argv[i] == '-last') {
            if ((i + 1) < argL) {
                info.lastIndex = parseInt(process.argv[i + 1]);
                i++;
            }
        }
        else if (process.argv[i] == '-out') {
            if ((i + 1) < argL) {
                info.outputDir = process.argv[i + 1];
                i++;
            }
        }
        else if (process.argv[i] == '-split') {
            info.singleFile = false;
        }
        else if (process.argv[i] == '-epub') {
            info.makeEpub = true;
        }
        else if (process.argv[i] == '-safe') {
            info.safeCooldown = true;
        }
        else if (process.argv[i] == '-nosafe') {
            info.safeCooldown = false;
        }
        else if (process.argv[i] == '-inspect') {
            info.inspectOnly = true;
        }
        else if (process.argv[i] == '-headless') {
            info.headless = 'auto';
        }
        else if (process.argv[i] == '-show') {
            info.headless = false;
        }
        else if (process.argv[i] == '-h' || process.argv[i] == '-help') {
            help();
        }
    }
    if (!info.url) {
        consoleGrey('url을 입력하세요');
        process.exit();
    }

    try {
        const parsedUrl = new URL(info.url);
        info.protocolDomain = parsedUrl.origin;
        const pathname = parsedUrl.pathname;
        const hostname = parsedUrl.hostname.toLowerCase();

        // 경로(/novel/, /webtoon/, /comic/)를 기준으로 판별
        if (pathname.includes('/novel/')) {
            info.site = 'booktoki';
            info.siteTitle = hostname.includes('newtoki') ? '뉴토끼' : (hostname.includes('manatoki') ? '마나토끼' : '북토끼');
        } else if (pathname.includes('/webtoon/')) {
            info.site = 'newtoki';
            info.siteTitle = '뉴토끼';
        } else if (pathname.includes('/comic/')) {
            info.site = 'manatoki';
            info.siteTitle = '마나토끼';
        } else {
            consoleGrey('회차 목록 페이지 url을 입력해야합니다. (/novel/, /webtoon/, /comic/ 경로 확인 필요)');
            process.exit();
        }
    } catch (error) {
        consoleGrey('유효한 URL 형식이 아닙니다: ' + info.url);
        process.exit();
    }
}
function saveBook(path, fileName, content) {
    if (!fs.existsSync(path))
        fs.mkdirSync(path, { recursive: true });
    fs.writeFileSync(`${path}/${fileName}`, content);
}
async function saveImage(page, path, fileName, src) {
    // 이미지버퍼 저장
    const imageBuffer = await page.evaluate(async (url) => {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        return Array.from(new Uint8Array(buffer)); // serialize-able 형태로 변환
    }, src);
    // 경로가 없다면 만들기
    if (!fs.existsSync(path))
        fs.mkdirSync(path, { recursive: true });
    // Buffer로 변환해서 파일 저장
    fs.writeFileSync(`${path}/${fileName}`, Buffer.from(imageBuffer));
}

function isValidNovelContent(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (trimmed.length < 50) return false;
    // 0x00 Null 바이트나 순수 공백/특수문자만 있는 빈 껍데기 파일 감지
    // 한글 문자([\uAC00-\uD7A3])가 최소 50자 이상 포함되어야 유효한 본문으로 인정
    const koreanMatches = trimmed.match(/[\uAC00-\uD7A3]/g);
    return koreanMatches !== null && koreanMatches.length >= 50;
}

function formatRanges(nums) {
    if (!nums || nums.length === 0) return '없음';
    const ranges = [];
    let start = nums[0];
    let prev = nums[0];
    for (let k = 1; k < nums.length; k++) {
        if (nums[k] === prev + 1) {
            prev = nums[k];
        } else {
            ranges.push(start === prev ? `${start}화` : `${start}화 ~ ${prev}화`);
            start = nums[k];
            prev = nums[k];
        }
    }
    ranges.push(start === prev ? `${start}화` : `${start}화 ~ ${prev}화`);
    return ranges.join(', ');
}

function updateCollectionStatusReport(baseDir, info, totalExpected) {
    try {
        const targetDir = `${baseDir}/개별화`;
        if (!fs.existsSync(targetDir)) return;

        const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.txt'));
        const validChapterNums = [];

        for (const f of files) {
            try {
                const content = fs.readFileSync(`${targetDir}/${f}`, 'utf8');
                if (isValidNovelContent(content)) {
                    const match = f.match(/^(\d+)/);
                    if (match) {
                        validChapterNums.push(parseInt(match[1], 10));
                    }
                }
            } catch (e) {}
        }

        validChapterNums.sort((a, b) => a - b);
        const validSet = new Set(validChapterNums);
        const maxNum = totalExpected || (validChapterNums.length > 0 ? validChapterNums[validChapterNums.length - 1] : 0);
        const missingChapterNums = [];

        for (let i = 1; i <= maxNum; i++) {
            if (!validSet.has(i)) {
                missingChapterNums.push(i);
            }
        }

        const percent = maxNum > 0 ? ((validChapterNums.length / maxNum) * 100).toFixed(1) : '0.0';
        const nowStr = new Date().toLocaleString('ko-KR');

        const report = `================================================================
📚 [${info.contentTitle}] 실시간 회차 수집 및 보존 현황판
================================================================
- 소설 제목: ${info.contentTitle} (작가: ${info.author || '미상'}, ${info.genre || '일반'})
- 총 감지 회차: ${maxNum}화
- 정상 확보 회차: ${validChapterNums.length}화 (${percent}%)
- 미수집(다운로드 필요): ${missingChapterNums.length}화

----------------------------------------------------------------
✅ [현재 정상 보존된 회차 목록] (총 ${validChapterNums.length}화)
----------------------------------------------------------------
${formatRanges(validChapterNums)}

----------------------------------------------------------------
📥 [추가 다운로드가 필요한 회차 목록] (총 ${missingChapterNums.length}화)
----------------------------------------------------------------
${formatRanges(missingChapterNums)}

================================================================
* 갱신 일시: ${nowStr}
* 안내: 정상 회차는 영구 보존되며, 다운로더 실행 시 재요청 없이 100% 캐시 사용됩니다.
================================================================
`;
        saveBook(baseDir, '회차_수집현황.txt', report);
    } catch (e) {}
}

async function getNovelContent(page) {
    // 본문(Shadow DOM 또는 레거시 엘리먼트)이 로드될 때까지 최대 15초 대기
    for (let attempt = 0; attempt < 30; attempt++) {
        const text = await page.evaluate(() => {
            // 0. 일일 조회 인증 락 감지
            const bodyText = document.body ? (document.body.innerText || '') : '';
            if (bodyText.includes('일일 조회 인증') || bodyText.includes('일일조회인증') || bodyText.includes('일반 소설 뷰어에서 인증')) {
                return '__RATE_LIMIT_DETECTED__';
            }

            // 1. 신규 Shadow DOM 웹소설 뷰어 지원
            const host = document.querySelector('[data-theme-novel-content]') || document.querySelector('.theme-novel-content');
            if (host && host.shadowRoot) {
                const nonStyleChildren = Array.from(host.shadowRoot.children).filter(c => c.tagName !== 'STYLE' && c.tagName !== 'SCRIPT');
                const pTexts = nonStyleChildren.map(c => (c.innerText || c.textContent || '').trim()).filter(t => t.length > 0);
                if (pTexts.length > 0) {
                    return pTexts.join('\n\n');
                }
            }

            // 2. 레거시 #novel_content 엘리먼트 지원
            const legacy = document.querySelector('#novel_content');
            if (legacy && legacy.innerText && legacy.innerText.trim().length > 30) {
                return legacy.innerText.trim();
            }

            return null;
        });

        if (text === '__RATE_LIMIT_DETECTED__') {
            return '__RATE_LIMIT_DETECTED__';
        }

        if (text && isValidNovelContent(text)) {
            return text;
        }
        await sleep(500);
    }
    return '';
}

async function main() {
    const isHeadless = info.headless !== false;
    const extraArgs = isHeadless
        ? ['--window-position=-32000,-32000', '--window-size=1280,800']
        : [];

    const { browser, page } = await connect({
        headless: isHeadless ? 'auto' : false,
        args: extraArgs,
        customConfig: {},
        turnstile: true, //captcha를 자동으로 풀것인지
        connectOption: { defaultViewport: null },
        disableXvfb: false, //화면을 볼것인지
    })
    try {
        await page.goto(info.url, { waitUntil: 'domcontentloaded' });
        // cloudflare에 막히기때문에 title이 바뀌거나 본문이 로드될 때까지 기다린다 (최대 60초 타임아웃).
        let cfWaitCount = 0;
        while (true) {
            const title = await page.title();
            if (!title.includes('Just a moment') && !title.includes('Cloudflare') && title.length > 0) {
                break;
            }
            await sleep(500);
            cfWaitCount++;
            if (cfWaitCount > 120) { // 60초 초과
                throw new Error("Cloudflare 봇 캡차 통과 시간 초과 (60초)");
            }
        }
        let link = [];
        // 연재 목록들의 링크를 알아낸다. {num:회차, fileName:연재제목, src:링크}로 구성되어있다.
        while (true) {
            await page.locator('.list-body').setTimeout(40000).wait();
            await sleep(1000);
            link = link.concat(await page.evaluate(() => {
                let list = Array.from(document.querySelector('.list-body').querySelectorAll('li'));
                for (let i = 0; i < list.length; i++) {
                    const rawNum = list[i].querySelector('.wr-num') ? list[i].querySelector('.wr-num').innerText.trim() : '';
                    const linkEl = list[i].querySelector('a');
                    if (!linkEl) continue;
                    const rawTitle = linkEl.innerHTML.replace(/<span[\s\S]*?\/span>/g, '').trim();

                    // 1. 제목에서 명시적인 회차 번호(예: "971화", "제 971화", "[971화]", "971.") 우선 추출
                    let detectedNum = null;
                    const titleMatch = rawTitle.match(/(?:제\s*)?(\d+)\s*(?:화|회)/i)
                        || rawTitle.match(/\[(?:제\s*)?(\d+)\]/)
                        || rawTitle.match(/^(\d+)\s*[\.\-\:\s]/);
                    if (titleMatch) {
                        const p = parseInt(titleMatch[1], 10);
                        if (!isNaN(p) && p > 0) detectedNum = p;
                    }

                    // 2. 제목에 없으면 wr-num 사용
                    if (detectedNum === null && rawNum) {
                        const p = parseInt(rawNum, 10);
                        if (!isNaN(p) && p > 0) detectedNum = p;
                    }

                    // 3. Fallback
                    const numVal = detectedNum !== null ? detectedNum : (i + 1);

                    // 회차 번호가 포함되지 않은 제목이면 "N화  제목" 형태로 가공
                    let finalTitle = rawTitle;
                    if (!/^(?:제\s*)?\d+\s*화/.test(rawTitle)) {
                        finalTitle = `${numVal}화  ${rawTitle}`;
                    }

                    list[i] = {
                        num: numVal.toString().padStart(4, '0'),
                        fileName: finalTitle,
                        src: linkEl.href
                    }
                }
                return list.filter(item => item && item.src);
            }));
            const metaInfo = await page.evaluate(() => {
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

                // 작가명
                const authorEl = document.querySelector('a[href*="author="]');
                const author = authorEl ? authorEl.innerText.trim() : '';

                // 장르 (1번째 장르) 및 발행상태(완결 여부)
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
                            if (rawGenres.length > 0 && rawGenres[0].trim()) {
                                firstGenre = rawGenres[0].trim();
                            }
                        }
                    }
                    if (!publishStatus && (t.includes('발행구분') || t.includes('연재상태') || t.includes('상태'))) {
                        const match = t.match(/(?:발행구분|연재상태|상태)\s*[\n:]\s*([^\n]+)/);
                        if (match) {
                            publishStatus = match[1].trim();
                            if (publishStatus.includes('완결')) {
                                isCompleted = true;
                            }
                        }
                    }
                }
                if (!firstGenre) {
                    const genreLink = document.querySelector('a[href*="genre="], a[href*="tag="]');
                    if (genreLink) firstGenre = genreLink.innerText.trim();
                }

                if (!isCompleted) {
                    const titleText = document.querySelector('.page-title')?.innerText || '';
                    if (titleText.includes('완결') || document.querySelector('.badge')?.innerText.includes('완결')) {
                        isCompleted = true;
                    }
                }

                return { title, author, firstGenre, isCompleted, publishStatus: publishStatus || (isCompleted ? '완결' : '연재중') };
            });
            info.contentTitle = sanitizeFilename(metaInfo.title);
            info.author = sanitizeFilename(metaInfo.author);
            info.genre = sanitizeFilename(metaInfo.firstGenre);
            info.isCompleted = metaInfo.isCompleted;
            info.publishStatus = metaInfo.publishStatus;

            // 다음 페이지가 없다면 break
            if (await page.$('ul.pagination li[class="active"] ~ li:not([class="disabled"]) a')) {
                await Promise.all([
                    page.waitForNavigation(),
                    page.locator('ul.pagination li[class="active"] ~ li:not([class="disabled"]) a').click()
                ]);
            }
            else
                break;
        }
        // URL 기준 중복 제거 및 회차 번호 기준 오름차순 정렬
        const uniqueMap = new Map();
        link.forEach(ep => {
            if (ep && ep.src && !uniqueMap.has(ep.src)) {
                uniqueMap.set(ep.src, ep);
            }
        });
        link = Array.from(uniqueMap.values()).sort((a, b) => parseInt(a.num, 10) - parseInt(b.num, 10));

        const minDetected = link.length > 0 ? parseInt(link[0].num, 10) : 1;
        const maxDetected = link.length > 0 ? parseInt(link.at(-1).num, 10) : 1;

        // 소설 정보 사전 조회(-inspect) 모드인 경우 JSON 출력 후 즉시 종료
        if (info.inspectOnly) {
            const resultData = {
                title: info.contentTitle,
                author: info.author || '미상',
                firstGenre: info.genre || '일반',
                isCompleted: info.isCompleted,
                publishStatus: info.publishStatus || (info.isCompleted ? '완결' : '연재중'),
                totalEpisodes: link.length,
                minNum: minDetected,
                maxNum: maxDetected
            };
            console.log("JSON_OUTPUT:" + JSON.stringify(resultData));
            await browser.close();
            return;
        }

        // info.startIndex와 info.lastIndex 필터하기
        link = link.filter(ep => {
            const n = parseInt(ep.num, 10);
            return n >= info.startIndex && n <= info.lastIndex;
        });

        if (link.length === 0) {
            consoleRed(`선택한 범위(${info.startIndex}화 ~ ${info.lastIndex}화)에 해당하는 회차가 없습니다.`);
            await browser.close();
            return;
        }
        // 페이지 방문하기
        const collectedChapters = [];
        let folderNameParts = [sanitizeFilename(info.contentTitle)];
        if (info.author && info.author !== '미상') {
            folderNameParts.push(sanitizeFilename(info.author));
        }
        const novelFolderName = folderNameParts.join('-');

        let baseDir;
        if (info.outputDir) {
            // outputDir 끝이 이미 해당 소설 폴더가 아니면 하위에 소설 폴더 생성
            const sanitizedOutputDir = info.outputDir.replace(/\\/g, '/');
            if (sanitizedOutputDir.endsWith(novelFolderName) || sanitizedOutputDir.endsWith(sanitizeFilename(info.contentTitle))) {
                baseDir = info.outputDir;
            } else {
                baseDir = `${info.outputDir}/${novelFolderName}`;
            }
        } else {
            baseDir = `./북토끼/${novelFolderName}`;
        }

        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }

        // 소설 폴더 안에 원본 URL 및 메타 정보 자동 보존
        const nowStr = new Date().toLocaleString('ko-KR');
        const urlInfoContent = `[소설 정보]
제목: ${info.contentTitle}
작가: ${info.author || '미상'}
장르: ${info.genre || '일반'}
상태: ${info.publishStatus || (info.isCompleted ? '완결' : '연재중')}
총 회차: ${link.length}화 (${info.startIndex}화 ~ ${info.lastIndex}화)
원본 URL: ${info.url}
수집 일시: ${nowStr}
`;
        saveBook(baseDir, 'url.txt', `${info.url}\n`);
        saveBook(baseDir, '소설정보.txt', urlInfoContent);

        const startNum = link.length > 0 ? parseInt(link[0].num) : 1;
        const lastNum = link.length > 0 ? parseInt(link.at(-1).num) : 1;
        let downloadedCountInSession = 0;

        // =============================================================
        // ⚡ 초고속 사전 캐시 스캔 (Pre-Scan): 루프 시작 전 단 1회 전수 검사
        // =============================================================
        const targetDir = `${baseDir}/개별화`;
        const localCacheMap = new Map();

        if (info.site === "booktoki" && fs.existsSync(targetDir)) {
            const existingFiles = fs.readdirSync(targetDir);
            for (const f of existingFiles) {
                if (!f.endsWith('.txt')) continue;
                try {
                    const content = fs.readFileSync(`${targetDir}/${f}`, 'utf8');
                    if (isValidNovelContent(content)) {
                        const match = f.match(/^(\d+)/);
                        if (match) {
                            const num = parseInt(match[1], 10);
                            const rawTitle = f.replace(/\.txt$/i, '').replace(/^\d+\s*/, '').trim() || `${num}화`;
                            localCacheMap.set(num, {
                                num: num,
                                title: rawTitle,
                                content: content.trim(),
                                filename: f
                            });
                        }
                    }
                } catch (e) {}
            }
        }

        // 대상 회차 분할: 이미 있는 회차 vs 새로 다운로드할 회차
        const cachedChapters = [];
        const missingLinks = [];

        if (info.site === "booktoki") {
            for (const ep of link) {
                const num = parseInt(ep.num, 10);
                if (localCacheMap.has(num)) {
                    cachedChapters.push(localCacheMap.get(num));
                } else {
                    missingLinks.push(ep);
                }
            }

            if (cachedChapters.length > 0) {
                console.log(`⚡ [사전 캐시 확인] 기존에 정상 저장된 ${cachedChapters.length}개 회차를 감지하여 0.01초 만에 즉시 통과합니다. (미수집 ${missingLinks.length}개 회차로 직행)`);
            }
        } else {
            // 웹툰/만화는 전체 순회
            missingLinks.push(...link);
        }

        const loopLinks = (info.site === "booktoki") ? missingLinks : link;
        const failedChapters = [];
        let rateLimitBlocked = false;

        for (let i = 0; i < loopLinks.length; i++) {
            const safeFileName = sanitizeFilename(loopLinks[i].fileName);
            const globalProgressIndex = cachedChapters.length + i + 1;
            console.log(`[${globalProgressIndex}/${link.length}] ${loopLinks[i].num} ${safeFileName} 진행중`);

            // 북토끼 / 뉴토끼 소설
            if (info.site === "booktoki") {
                const paddedNum = loopLinks[i].num.toString().padStart(4, '0');
                const targetFile = `${paddedNum} ${safeFileName}.txt`;

                let fileContent = '';

                // 웹 접속 및 최대 3회 재시도
                for (let retry = 1; retry <= 3; retry++) {
                    try {
                        await page.goto(loopLinks[i].src, { waitUntil: 'domcontentloaded' });
                        fileContent = await getNovelContent(page);

                        // 일일 조회 인증 락 감지 시 120초 자동 쿨다운 대기
                        if (fileContent === '__RATE_LIMIT_DETECTED__') {
                            consoleGrey(`  ⚠️ [조회 제한 감지] 사이트 일일 조회 락 감지. 120초간 대기 후 재시도합니다...`);
                            for (let sec = 120; sec > 0; sec -= 30) {
                                console.log(`    ⏳ 락 해제 대기 중: ${sec}초 남음...`);
                                await sleep(30000);
                            }
                            // 쿨다운 후 1회 추가 확인
                            fileContent = await getNovelContent(page);
                            if (fileContent === '__RATE_LIMIT_DETECTED__') {
                                rateLimitBlocked = true;
                                consoleGrey(`  ❌ [조회 제한 지속] 일일 조회 락이 해제되지 않았습니다. (계정/IP 차단 상태)`);
                                fileContent = '';
                                break;
                            }
                        }

                        if (fileContent && isValidNovelContent(fileContent)) {
                            saveBook(targetDir, targetFile, fileContent);
                            console.log(`  -> ${loopLinks[i].num} ${safeFileName} 저장 완료 (${fileContent.length}자)`);
                            downloadedCountInSession++;
                            break;
                        }
                    } catch (err) {
                        consoleGrey(`  -> [재시도 ${retry}/3] 페이지 접속 오류: ${err.message}`);
                    }
                    if (retry < 3) await sleep(2000);
                }

                // 본문 추출 실패 처리
                if (!fileContent || !isValidNovelContent(fileContent)) {
                    consoleGrey(`  ❌ 본문 수집 실패: ${loopLinks[i].num} ${safeFileName} ${rateLimitBlocked ? '(사유: 일일 조회 제한 차단)' : ''}`);
                    failedChapters.push({
                        num: parseInt(loopLinks[i].num, 10),
                        title: loopLinks[i].fileName,
                        reason: rateLimitBlocked ? '사이트 조회수 제한 차단' : '본문 추출 실패'
                    });

                    // 사이트 차단(락)이 확인된 경우 더 이상 무의미한 반복 요청을 중단하고 즉시 루프 종료
                    if (rateLimitBlocked) {
                        console.log(`\n🛑 [다운로드 중단] 사이트 일일 조회수 제한(차단)으로 인해 안전을 위해 다운로드를 중단합니다.`);
                        console.log(`💡 현재까지 수집된 회차는 안전하게 디스크에 보존되었습니다.\n`);
                        // 남은 미수집 회차들도 실패 목록에 추가
                        for (let k = i + 1; k < loopLinks.length; k++) {
                            failedChapters.push({
                                num: parseInt(loopLinks[k].num, 10),
                                title: loopLinks[k].fileName,
                                reason: '사이트 조회수 제한으로 인한 중단'
                            });
                        }
                        break;
                    }
                } else {
                    collectedChapters.push({
                        num: loopLinks[i].num,
                        title: loopLinks[i].fileName,
                        content: fileContent
                    });
                }

                // ☕ 배치 쿨다운: 150화 연속 다운로드 시 사이트 락 방지를 위해 60초 자동 휴식
                if (info.safeCooldown && downloadedCountInSession > 0 && downloadedCountInSession % 150 === 0) {
                    console.log(`\n☕ [안전 쿨다운] ${downloadedCountInSession}화 연속 다운로드 완료! 캡차 락 방지를 위해 60초간 잠시 휴식합니다...`);
                    for (let sec = 60; sec > 0; sec -= 15) {
                        console.log(`  ⏳ 쿨다운 진행 중: ${sec}초 남음...`);
                        await sleep(15000);
                    }
                    console.log(`✨ 쿨다운 완료! 다운로드를 계속 진행합니다.\n`);
                } else {
                    // WAF 차단 방지 지터 딜레이 (1.5초 ~ 2.5초)
                    const jitter = 1500 + Math.random() * 1000;
                    await sleep(jitter);
                }
            }
            // 뉴토끼, 마나토끼 (웹툰/만화)
            else {
                const comicBase = info.outputDir ? info.outputDir : `./${info.siteTitle}/${info.contentTitle}`;
                const path = `${comicBase}/${loopLinks[i].num} ${safeFileName}`;
                await page.goto(loopLinks[i].src, { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('.view-padding div img', { timeout: 30000 }).catch(() => {});
                
                // 이미지 가져오기
                let imgLists = await page.evaluate(() => {
                    let imgLists = Array.from(document.querySelectorAll('.view-padding div img'));
                    let returnList = [];
                    // 화면에 보이지 않는 이미지라면 리스트에서 제거
                    for (let j = 0; j < imgLists.length;) {
                        if (imgLists[j].checkVisibility() === false)
                            imgLists.splice(j, 1);
                        else {
                            let src = imgLists[j].outerHTML;
                            try {
                                src = `${src.match(/\/data[^"]+/)[0]}`;
                                const extension = src.match(/\.[a-zA-Z]+$/)[0];
                                returnList.push({ src, extension });
                            } 
                            catch (error) {}
                            j++;
                        }
                    }
                    return returnList;
                });
                console.log(`이미지 ${imgLists.length}개 감지`);
                let promiseList = [];
                // 이미지들을 다운로드한다.
                for (let j = 0; j < imgLists.length; j++) {
                    const fileName = `${loopLinks[i].num} ${safeFileName} image${j.toString().padStart(4, '0')}${imgLists[j].extension}`;
                    if (!fs.existsSync(`${path}/${fileName}`))
                        promiseList.push(saveImage(page, path, fileName, `${info.protocolDomain}${imgLists[j].src}`));
                }
                await Promise.all(promiseList);
                await sleep(1500 + Math.random() * 1000);
            }
        }

        // 소설 파일 생성 (TXT 및 EPUB) - 로컬 개별화 폴더의 유효 회차만 누적 병합
        let hasIncompleteChapters = false;
        if (info.site === "booktoki") {
            const targetDir = `${baseDir}/개별화`;
            let localChapters = [];
            const localMap = new Map();

            if (fs.existsSync(targetDir)) {
                const allFiles = fs.readdirSync(targetDir);
                for (const f of allFiles) {
                    if (!f.endsWith('.txt')) continue;
                    try {
                        const content = fs.readFileSync(`${targetDir}/${f}`, 'utf8');
                        if (!isValidNovelContent(content)) continue; // 손상/빈 파일은 병합에서 제외
                        const match = f.match(/^(\d+)/);
                        const num = match ? parseInt(match[1], 10) : 0;
                        const rawTitle = f.replace(/\.txt$/i, '').replace(/^\d+\s*/, '').trim() || `${num}화`;
                        const chObj = {
                            num: num,
                            title: rawTitle,
                            content: content.trim()
                        };
                        localChapters.push(chObj);
                        localMap.set(num, chObj);
                    } catch (e) {}
                }
                localChapters.sort((a, b) => a.num - b.num);
            }

            const finalChaptersToMerge = localChapters.length > 0 ? localChapters : collectedChapters;

            // 요청된 회차 범위 중 실제로 디스크에 없는 누락 회차 산출
            const finalMissingEpisodes = link.filter(ep => !localMap.has(parseInt(ep.num, 10)));
            hasIncompleteChapters = finalMissingEpisodes.length > 0 || failedChapters.length > 0;

            if (finalChaptersToMerge.length > 0) {
                let parts = [sanitizeFilename(info.contentTitle)];
                if (info.author) parts.push(sanitizeFilename(info.author));
                if (info.genre) parts.push(sanitizeFilename(info.genre));
                const baseFileName = parts.join('-');

                const minCh = finalChaptersToMerge[0].num;
                const maxCh = finalChaptersToMerge[finalChaptersToMerge.length - 1].num;
                const isAllComplete = (minCh === 1 && maxCh >= (info.rawTotalCount || finalChaptersToMerge.length) && finalMissingEpisodes.length === 0);

                let tag = '';
                if (info.isCompleted && isAllComplete) {
                    tag = '[완결]';
                } else if (finalChaptersToMerge.length === (maxCh - minCh + 1)) {
                    tag = `[${minCh}화~${maxCh}화]`;
                } else {
                    tag = `[${minCh}화~${maxCh}화 (보존 ${finalChaptersToMerge.length}화)]`;
                }

                // 1. TXT 통합 파일 생성
                if (info.singleFile) {
                    console.log(`\n📄 소설 통합 텍스트 파일 생성 중 (총 ${finalChaptersToMerge.length}개 회차 결합)...`);
                    let fullBook = '';
                    finalChaptersToMerge.forEach(c => {
                        fullBook += `${c.title}\n\n`;
                        fullBook += `${c.content}\n\n\n`;
                    });

                    const singleFileName = `${baseFileName} ${tag}.txt`;
                    saveBook(baseDir, singleFileName, fullBook);
                    console.log(`📄 통합 텍스트 파일 저장 완료: ${baseDir}/${singleFileName}`);
                }

                // 2. EPUB 전자책 파일 생성 (옵션)
                if (info.makeEpub) {
                    console.log(`\n📚 소설 EPUB 전자책 생성 중 (총 ${finalChaptersToMerge.length}개 회차 결합)...`);
                    try {
                        const epub = new EpubBuilder();
                        finalChaptersToMerge.forEach(c => {
                            epub.addChapter(c.title, c.content);
                        });
                        const epubFileName = `${baseFileName} ${tag}.epub`;
                        await epub.saveToFile(`${baseDir}/${epubFileName}`, {
                            title: info.contentTitle,
                            author: info.author || '미상'
                        });
                        console.log(`📚 EPUB 전자책 저장 완료: ${baseDir}/${epubFileName}`);
                    } catch (e) {
                        consoleGrey(`❌ EPUB 생성 실패: ${e.message}`);
                    }
                }

                console.log(`💾 개별 회차 파일 안전 보존 (${baseDir}/개별화 - 총 ${finalChaptersToMerge.length}개 파일 보관 중)`);
                updateCollectionStatusReport(baseDir, info, info.rawTotalCount || maxCh);
            }

            // 최종 완료 / 실패 요약 리포트 출력 및 종료 코드 설정
            console.log(`\n================================================================`);
            if (!hasIncompleteChapters) {
                console.log(`🎉 [다운로드 완료] 선택하신 모든 회차(총 ${link.length}화)가 100% 정상 수집되었습니다!`);
                console.log(`================================================================\n`);
                process.exitCode = 0;
            } else {
                const missingNums = finalMissingEpisodes.map(e => parseInt(e.num, 10));
                console.log(`❌ [다운로드 미완료] 총 ${link.length}화 중 ${missingNums.length}개 회차 수집 실패 (${link.length - missingNums.length}화 확보됨)`);
                console.log(`  - 누락/실패 회차: ${formatRanges(missingNums)}`);
                if (rateLimitBlocked) {
                    console.log(`  - 실패 원인: 사이트 일일 조회수 제한(계정/IP 차단 감지)`);
                }
                console.log(`  - 안내: 이미 다운로드된 회차는 안전하게 보존되어 있으며, 차단 해제 후 재실행 시 이어서 수집됩니다.`);
                console.log(`================================================================\n`);
                process.exitCode = 1;
            }
        }
    } catch (error) {
        console.log(error);
        process.exitCode = 1;
        await browser.close();
    } finally {
        await browser.close();
    }
}

analyseArguments();
main();
