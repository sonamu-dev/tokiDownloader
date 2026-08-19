import { connect } from "puppeteer-real-browser";
import fs from 'node:fs';

let info = {
    url: '',
    protocolDomain: 'https://booktoki350.com',
    siteTitle: '북토끼',
    site: 'booktoki',
    startIndex: 0,
    lastIndex: 99999,
    contentTitle: '소설',
    outputDir: '',
    singleFile: true // 통합 텍스트 파일(목차 포함) 기본 생성
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

        if (text && text.length > 30) {
            return text;
        }
        await sleep(500);
    }
    return '';
}

async function main() {
    const { browser, page } = await connect({
        headless: false,
        args: [],
        customConfig: {},
        turnstile: true, //captcha를 자동으로 풀것인지
        connectOption: { defaultViewport: null },
        disableXvfb: false, //화면을 볼것인지
    })
    try {
        await page.goto(info.url, { waitUntil: 'domcontentloaded' });
        // cloudflare에 막히기때문에 title이 바뀌거나 본문이 로드될 때까지 기다린다.
        while (true) {
            const title = await page.title();
            if (!title.includes('Just a moment') && !title.includes('Cloudflare') && title.length > 0) {
                break;
            }
            await sleep(500);
        }
        let link = [];
        // 연재 목록들의 링크를 알아낸다. {num:회차, fileName:연재제목, src:링크}로 구성되어있다.
        while (true) {
            await page.locator('.list-body').setTimeout(40000).wait();
            await sleep(1000);
            link = link.concat(await page.evaluate(() => {
                let list = Array.from(document.querySelector('.list-body').querySelectorAll('li'));
                for (let i = 0; i < list.length; i++) {
                    list[i] = {
                        num: list[i].querySelector('.wr-num').innerText.padStart(4, '0'),
                        fileName: list[i].querySelector('a').innerHTML.replace(/<span[\s\S]*?\/span>/g, '').trim(),
                        src: list[i].querySelector('a').href
                    }
                }
                return list;
            }));
            const rawTitle = await page.evaluate(() => {
                const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
                if (ogTitle) return ogTitle.split(' - ')[0].trim();
                if (document.title) return document.title.split(' - ')[0].trim();
                const pageTitle = document.querySelector('.page-title');
                if (pageTitle) {
                    const clone = pageTitle.cloneNode(true);
                    clone.querySelectorAll('.page-desc, span').forEach(e => e.remove());
                    return clone.innerText.trim();
                }
                return '제목없음';
            });
            info.contentTitle = sanitizeFilename(rawTitle);

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
        // 1화부터 받을것이기 때문에 리버스 해준다.
        link.reverse();
        // info.startIndex와 info.lastIndex필터하기.
        while (link.length > 0 && parseInt(link[0].num) < info.startIndex) {
            link.shift();
        }
        while (link.length > 0 && info.lastIndex < parseInt(link.at(-1).num)) {
            link.pop();
        }
        // 페이지 방문하기
        const collectedChapters = [];
        const baseDir = info.outputDir ? info.outputDir : `./북토끼/${info.contentTitle}`;
        const startNum = link.length > 0 ? parseInt(link[0].num) : 1;
        const lastNum = link.length > 0 ? parseInt(link.at(-1).num) : 1;

        for (let i = 0; i < link.length; i++) {
            const safeFileName = sanitizeFilename(link[i].fileName);
            console.log(`[${i + 1}/${link.length}] ${link[i].num} ${safeFileName} 진행중`);

            // 북토끼 / 뉴토끼 소설
            if (info.site === "booktoki") {
                const targetDir = `${baseDir}/개별화`;
                const targetFile = `${link[i].num} ${safeFileName}.txt`;

                let fileContent = '';
                // 이미 존재하면 읽어오기
                if (fs.existsSync(`${targetDir}/${targetFile}`)) {
                    console.log(`이미 저장된 파일에서 로드: ${targetFile}`);
                    fileContent = fs.readFileSync(`${targetDir}/${targetFile}`, 'utf8');
                } else {
                    await page.goto(link[i].src, { waitUntil: 'domcontentloaded' });
                    fileContent = await getNovelContent(page);
                    if (fileContent && fileContent.length > 0) {
                        saveBook(targetDir, targetFile, fileContent);
                        console.log(`  -> ${link[i].num} ${safeFileName} 저장 완료 (${fileContent.length}자)`);
                    } else {
                        consoleGrey(`  -> 본문 추출 실패: ${link[i].num} ${safeFileName}`);
                    }
                    // WAF 차단 방지 지터 딜레이 (1.5초 ~ 2.5초)
                    const jitter = 1500 + Math.random() * 1000;
                    await sleep(jitter);
                }

                if (fileContent && fileContent.length > 0) {
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

        // 소설 통합 텍스트 파일(목차 포함) 생성
        if (info.site === "booktoki" && info.singleFile && collectedChapters.length > 0) {
            console.log(`\n📄 소설 통합 텍스트 파일 생성 중 (목차 자동 삽입)...`);
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

            let fullBook = `================================================================\n`;
            fullBook += `[ ${info.contentTitle} ]\n`;
            fullBook += `총 ${collectedChapters.length}화 수집 (${startNum}화 ~ ${lastNum}화)\n`;
            fullBook += `다운로드 일시: ${dateStr}\n`;
            fullBook += `================================================================\n\n`;
            fullBook += `[ 목차 ]\n`;

            collectedChapters.forEach(c => {
                fullBook += `${c.title}\n`;
            });

            fullBook += `\n================================================================\n\n\n`;

            collectedChapters.forEach(c => {
                fullBook += `=== ${c.title} ===\n\n`;
                fullBook += `${c.content}\n\n\n`;
            });

            const singleFileName = `${sanitizeFilename(info.contentTitle)} [${startNum}화~${lastNum}화].txt`;
            saveBook(baseDir, singleFileName, fullBook);
            console.log(`🎉 통합 텍스트 파일 생성 완료: ${baseDir}/${singleFileName}`);
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
