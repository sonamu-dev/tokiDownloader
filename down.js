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

        if (text && text.length > 30) {
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

        for (let i = 0; i < link.length; i++) {
            const safeFileName = sanitizeFilename(link[i].fileName);
            console.log(`[${i + 1}/${link.length}] ${link[i].num} ${safeFileName} 진행중`);

            // 북토끼 / 뉴토끼 소설
            if (info.site === "booktoki") {
                const targetDir = `${baseDir}/개별화`;
                const targetFile = `${link[i].num} ${safeFileName}.txt`;

                let fileContent = '';
                // 1. 이미 정상 저장된 파일(30자 이상)이 존재하면 웹 요청 없이 즉시 스킵 (스마트 이어받기)
                if (fs.existsSync(`${targetDir}/${targetFile}`)) {
                    try {
                        const existing = fs.readFileSync(`${targetDir}/${targetFile}`, 'utf8');
                        if (existing && existing.trim().length > 30) {
                            console.log(`  ⚡ [스킵] 이미 다운로드된 회차 로컬 캐시 사용 (${existing.trim().length}자)`);
                            fileContent = existing.trim();
                        }
                    } catch (e) {}
                }

                // 2. 파일이 없거나 유효하지 않은 경우 웹 접속 및 최대 3회 재시도
                if (!fileContent) {
                    for (let retry = 1; retry <= 3; retry++) {
                        try {
                            await page.goto(link[i].src, { waitUntil: 'domcontentloaded' });
                            fileContent = await getNovelContent(page);

                            // 일일 조회 인증 락 감지 시 120초 자동 쿨다운 대기
                            if (fileContent === '__RATE_LIMIT_DETECTED__') {
                                consoleGrey(`  ⚠️ [조회 제한 감지] 사이트 쿨다운을 위해 120초간 대기 후 자동 재시도합니다...`);
                                for (let sec = 120; sec > 0; sec -= 30) {
                                    console.log(`    ⏳ 락 해제 대기 중: ${sec}초 남음...`);
                                    await sleep(30000);
                                }
                                fileContent = '';
                                continue;
                            }

                            if (fileContent && fileContent.length > 30) {
                                saveBook(targetDir, targetFile, fileContent);
                                console.log(`  -> ${link[i].num} ${safeFileName} 저장 완료 (${fileContent.length}자)`);
                                downloadedCountInSession++;
                                break;
                            }
                        } catch (err) {
                            consoleGrey(`  -> [재시도 ${retry}/3] 페이지 접속 오류: ${err.message}`);
                        }
                        if (retry < 3) await sleep(2000);
                    }

                    if (!fileContent || fileContent.length <= 30) {
                        consoleGrey(`  -> 본문 추출 최종 실패: ${link[i].num} ${safeFileName}`);
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

                if (fileContent && fileContent.length > 30) {
                    collectedChapters.push({
                        num: link[i].num,
                        title: link[i].fileName,
                        content: fileContent
                    });
                }
            }
            // 뉴토끼, 마나토끼 (웹툰/만화)
            else {
                const comicBase = info.outputDir ? info.outputDir : `./${info.siteTitle}/${info.contentTitle}`;
                const path = `${comicBase}/${link[i].num} ${safeFileName}`;
                await page.goto(link[i].src, { waitUntil: 'domcontentloaded' });
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
                    const fileName = `${link[i].num} ${safeFileName} image${j.toString().padStart(4, '0')}${imgLists[j].extension}`;
                    if (!fs.existsSync(`${path}/${fileName}`))
                        promiseList.push(saveImage(page, path, fileName, `${info.protocolDomain}${imgLists[j].src}`));
                }
                await Promise.all(promiseList);
                await sleep(1500 + Math.random() * 1000);
            }
        }

        // 소설 파일 생성 (TXT 및 EPUB)
        if (info.site === "booktoki" && collectedChapters.length > 0) {
            let parts = [sanitizeFilename(info.contentTitle)];
            if (info.author) parts.push(sanitizeFilename(info.author));
            if (info.genre) parts.push(sanitizeFilename(info.genre));
            const baseFileName = parts.join('-');

            const isAllDownload = (startNum === 1 && lastNum >= (info.rawTotalCount || collectedChapters.length));
            let tag = '';
            if (info.isCompleted && isAllDownload) {
                tag = '[완결]';
            } else {
                tag = `[${startNum}화~${lastNum}화]`;
            }

            // 1. TXT 통합 파일 생성
            if (info.singleFile) {
                console.log(`\n📄 소설 통합 텍스트 파일 생성 중...`);
                let fullBook = '';
                collectedChapters.forEach(c => {
                    fullBook += `${c.title}\n\n`;
                    fullBook += `${c.content}\n\n\n`;
                });

                const singleFileName = `${baseFileName} ${tag}.txt`;
                saveBook(baseDir, singleFileName, fullBook);
                console.log(`🎉 통합 텍스트 파일 생성 완료: ${baseDir}/${singleFileName}`);
            }

            // 2. EPUB 전자책 파일 생성 (옵션)
            if (info.makeEpub) {
                console.log(`\n📚 소설 EPUB 전자책 생성 중...`);
                try {
                    const epub = new EpubBuilder();
                    collectedChapters.forEach(c => {
                        epub.addChapter(c.title, c.content);
                    });
                    const epubFileName = `${baseFileName} ${tag}.epub`;
                    await epub.saveToFile(`${baseDir}/${epubFileName}`, {
                        title: info.contentTitle,
                        author: info.author || '미상'
                    });
                    console.log(`🎉 EPUB 전자책 생성 완료: ${baseDir}/${epubFileName}`);
                } catch (e) {
                    consoleGrey(`❌ EPUB 생성 실패: ${e.message}`);
                }
            }

            // 모든 요청 회차가 정상 수집되었을 때만 개별 임시 파일 정리 (미완료 시 이어받기용 보존)
            if (collectedChapters.length === link.length) {
                const targetDir = `${baseDir}/개별화`;
                if (fs.existsSync(targetDir)) {
                    try {
                        fs.rmSync(targetDir, { recursive: true, force: true });
                        console.log(`🧹 개별 임시 파일 정리 완료`);
                    } catch (e) {}
                }
            }
        }
    } catch (error) {
        console.log(error);
        await browser.close();
    } finally {
        await browser.close();
    }

}

analyseArguments();
main();
