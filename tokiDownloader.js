// ==UserScript==
// @name         tokiDownloader (Novel GUI & TOC Edition)
// @namespace    https://github.com/crossSiteKikyo/tokiDownloader
// @version      1.0.0
// @description  북토끼/뉴토끼/마나토끼 웹소설 전용 GUI 다운로더 (목차 자동 생성, 로컬 폴더 지정, 진행률 표시, 안티봇 회피 지원)
// @author       hehaho, sonamu-dev
// @match        *://*/*novel/*
// @match        *://*/*webtoon/*
// @match        *://*/*comic/*
// @icon         https://github.com/user-attachments/assets/99f5bb36-4ef8-40cc-8ae5-e3bf1c7952ad
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.7.1/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip-utils/0.1.0/jszip-utils.js
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // =============================================================
    // 🌐 사이트 및 기본 환경 감지
    // =============================================================
    const currentURL = document.URL;
    let siteType = 'novel'; // 'novel' | 'webtoon' | 'comic'
    let siteName = '북토끼';
    let protocolDomain = window.location.origin;

    try {
        const parsed = new URL(currentURL);
        protocolDomain = parsed.origin;
        const pathname = parsed.pathname;
        const hostname = parsed.hostname.toLowerCase();

        if (pathname.includes('/novel/')) {
            siteType = 'novel';
            siteName = hostname.includes('newtoki') ? '뉴토끼(소설)' : (hostname.includes('manatoki') ? '마나토끼(소설)' : '북토끼');
        } else if (pathname.includes('/webtoon/')) {
            siteType = 'webtoon';
            siteName = '뉴토끼(웹툰)';
        } else if (pathname.includes('/comic/')) {
            siteType = 'comic';
            siteName = '마나토끼(만화)';
        } else {
            return;
        }
    } catch (e) {
        return;
    }

    // =============================================================
    // 🛠️ 유틸리티 함수들
    // =============================================================
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function sanitizeFilename(name) {
        if (!name) return '';
        return name.replace(/[\\/:*?"<>|]/g, '_').trim();
    }

    function escapeXml(unsafe) {
        if (typeof unsafe !== 'string') return '';
        return unsafe.replace(/[<>&'"]/g, c => {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '\'': return '&apos;';
                case '"': return '&quot;';
                default: return c;
            }
        });
    }

    // 소설 텍스트 및 문단 정제 함수
    function cleanNovelText(htmlOrText) {
        if (!htmlOrText) return '';
        let text = htmlOrText
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

    // 백그라운드 스로틀링 방지 (Anti-Sleep Web Audio)
    let audioCtx = null;
    function startAntiSleep() {
        try {
            if (!audioCtx) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (AudioContext) {
                    audioCtx = new AudioContext();
                    const osc = audioCtx.createOscillator();
                    const gain = audioCtx.createGain();
                    gain.gain.value = 0.00001; // 거의 무음
                    osc.connect(gain);
                    gain.connect(audioCtx.destination);
                    osc.start();
                }
            }
        } catch (e) {}
    }
    function stopAntiSleep() {
        if (audioCtx) {
            try { audioCtx.close(); } catch (e) {}
            audioCtx = null;
        }
    }

    // =============================================================
    // 📖 소설 메타데이터 & 회차 목록 수집 엔진
    // =============================================================
    function getSeriesInfo(doc = document) {
        const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
        let title = '';
        if (ogTitle) title = ogTitle.split(' - ')[0].trim();
        else if (doc.title) title = doc.title.split(' - ')[0].trim();
        const pageTitle = doc.querySelector('.page-title span') || doc.querySelector('.page-title');
        if (pageTitle) {
            const clone = pageTitle.cloneNode(true);
            clone.querySelectorAll('.page-desc, span').forEach(e => e.remove());
            const t = clone.innerText.trim();
            if (t) title = t;
        }
        title = (title || '소설').replace(/웹소설.*$/, '').trim();

        // 작가명
        const authorEl = doc.querySelector('a[href*="author="]');
        const author = authorEl ? authorEl.innerText.trim() : '';

        // 장르 (1번째 장르)
        let firstGenre = '';
        const allTextElements = Array.from(doc.querySelectorAll('td, div, tr, p, span'));
        for (const el of allTextElements) {
            const t = el.innerText || '';
            if (t.startsWith('장르') || t.includes('\n장르\n') || t.includes('장르\n') || t.includes('장르 :')) {
                const match = t.match(/장르\s*[\n:]\s*([^\n]+)/);
                if (match) {
                    const rawGenres = match[1].split(',');
                    if (rawGenres.length > 0 && rawGenres[0].trim()) {
                        firstGenre = rawGenres[0].trim();
                        break;
                    }
                }
            }
        }
        if (!firstGenre) {
            const genreLink = doc.querySelector('a[href*="genre="], a[href*="tag="]');
            if (genreLink) firstGenre = genreLink.innerText.trim();
        }

        return {
            title,
            author,
            firstGenre
        };
    }

    function formatNovelFileName(title, author, genre, rangeLabel) {
        const safeTitle = sanitizeFilename(title);
        const safeAuthor = sanitizeFilename(author);
        const safeGenre = sanitizeFilename(genre);

        let parts = [safeTitle];
        if (safeAuthor) parts.push(safeAuthor);
        if (safeGenre) parts.push(safeGenre);

        const baseName = parts.join('-');
        if (rangeLabel) {
            return `${baseName} [${rangeLabel}].txt`;
        }
        return `${baseName}.txt`;
    }

    function getSeriesTitle() {
        return getSeriesInfo().title;
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

    function parseEpisodesFromDoc(doc) {
        const listBody = doc.querySelector('.list-body');
        if (!listBody) return [];

        const items = Array.from(listBody.querySelectorAll('li'));
        const episodes = [];

        items.forEach(li => {
            const numEl = li.querySelector('.wr-num');
            const linkEl = li.querySelector('a');
            if (!linkEl) return;

            const rawNum = numEl ? numEl.innerText.trim() : '';
            const numVal = parseInt(rawNum, 10);
            const numStr = isNaN(numVal) ? '0000' : numVal.toString().padStart(4, '0');

            // <span> 태그 등 노이즈 제거한 순수 회차 제목
            const clone = linkEl.cloneNode(true);
            clone.querySelectorAll('span').forEach(s => s.remove());
            const rawTitle = clone.innerText.trim();
            const formattedTitle = formatChapterTitle(numVal, rawTitle);
            const url = linkEl.href;

            episodes.push({
                num: numVal || 0,
                numStr: numStr,
                title: formattedTitle,
                rawTitle: rawTitle,
                url: url
            });
        });

        return episodes;
    }

    async function fetchAllEpisodePages(onProgress) {
        // 1. 현재 페이지의 회차 수집
        let allEpisodes = parseEpisodesFromDoc(document);
        
        // 2. 페이지네이션 링크 탐색
        const paginationLinks = Array.from(document.querySelectorAll('ul.pagination li a'))
            .map(a => a.href)
            .filter((href, idx, self) => href && self.indexOf(href) === idx && href !== window.location.href);

        if (paginationLinks.length > 0) {
            onProgress?.(`전체 목록 페이지 탐색 중... (총 ${paginationLinks.length + 1}페이지)`);
            for (let i = 0; i < paginationLinks.length; i++) {
                const pUrl = paginationLinks[i];
                try {
                    const resp = await fetch(pUrl);
                    const html = await resp.text();
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(html, 'text/html');
                    const pageEpisodes = parseEpisodesFromDoc(doc);
                    allEpisodes = allEpisodes.concat(pageEpisodes);
                    onProgress?.(`목록 수집 중... (${i + 2}/${paginationLinks.length + 1} 페이지)`);
                    await sleep(300);
                } catch (e) {
                    console.warn('페이지네이션 수집 실패:', pUrl, e);
                }
            }
        }

        // 중복 제거 (URL 기준) 및 1화부터 오름차순 정렬
        const uniqueMap = new Map();
        allEpisodes.forEach(ep => {
            if (ep.url && !uniqueMap.has(ep.url)) {
                uniqueMap.set(ep.url, ep);
            }
        });

        const sortedEpisodes = Array.from(uniqueMap.values()).sort((a, b) => a.num - b.num);
        return sortedEpisodes;
    }

    // =============================================================
    // 📑 문서 서두 목차(Index) 생성기
    // =============================================================
    function buildTableOfContents(seriesTitle, episodes, startIndex, lastIndex) {
        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        let header = `================================================================\n`;
        header += `[ ${seriesTitle} ]\n`;
        header += `총 ${episodes.length}화 수집 (${startIndex}화 ~ ${lastIndex}화)\n`;
        header += `다운로드 일시: ${dateStr}\n`;
        header += `================================================================\n\n`;
        header += `[ 목차 ]\n`;

        episodes.forEach(ep => {
            header += `${ep.title}\n`;
        });

        header += `\n================================================================\n\n\n`;
        return header;
    }

    // =============================================================
    // 🎨 UI 컴포넌트 & 스타일 (Modern Glassmorphism)
    // =============================================================
    const UI_STYLE = `
        #toki-gui-launcher {
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 999999;
            background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
            color: #ffffff;
            border: 1px solid rgba(255, 255, 255, 0.25);
            padding: 12px 18px;
            border-radius: 50px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 14px;
            font-weight: 700;
            box-shadow: 0 8px 32px rgba(99, 102, 241, 0.4);
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            backdrop-filter: blur(8px);
        }
        #toki-gui-launcher:hover {
            transform: translateY(-2px) scale(1.03);
            box-shadow: 0 12px 40px rgba(168, 85, 247, 0.5);
        }
        #toki-gui-modal {
            position: fixed;
            bottom: 84px;
            right: 24px;
            width: 440px;
            max-width: calc(100vw - 48px);
            max-height: 85vh;
            background: rgba(18, 20, 29, 0.92);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 20px;
            color: #f1f5f9;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            z-index: 999999;
            box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
            display: none;
            flex-direction: column;
            overflow: hidden;
            animation: tokiSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes tokiSlideUp {
            from { opacity: 0; transform: translateY(20px) scale(0.96); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .toki-header {
            padding: 16px 20px;
            background: rgba(255, 255, 255, 0.04);
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .toki-title {
            font-size: 16px;
            font-weight: 800;
            background: linear-gradient(135deg, #818cf8, #c084fc);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .toki-close-btn {
            background: none;
            border: none;
            color: #94a3b8;
            font-size: 20px;
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 8px;
            transition: 0.2s;
        }
        .toki-close-btn:hover {
            color: #fff;
            background: rgba(255, 255, 255, 0.1);
        }
        .toki-body {
            padding: 20px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        .toki-card {
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            padding: 14px;
        }
        .toki-card-title {
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: #94a3b8;
            margin-bottom: 8px;
            font-weight: 700;
        }
        .toki-series-name {
            font-size: 15px;
            font-weight: 700;
            color: #ffffff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-bottom: 4px;
        }
        .toki-series-meta {
            font-size: 12px;
            color: #818cf8;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .toki-scan-btn {
            background: rgba(99, 102, 241, 0.2);
            border: 1px solid rgba(99, 102, 241, 0.4);
            color: #a5b4fc;
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 11px;
            cursor: pointer;
            transition: 0.2s;
        }
        .toki-scan-btn:hover {
            background: rgba(99, 102, 241, 0.4);
            color: #fff;
        }
        .toki-radio-group {
            display: flex;
            flex-direction: column;
            gap: 10px;
            font-size: 13px;
        }
        .toki-radio-item {
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
        }
        .toki-radio-item input[type="radio"] {
            accent-color: #a855f7;
            cursor: pointer;
        }
        .toki-range-inputs {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-left: 24px;
            margin-top: 6px;
        }
        .toki-input {
            width: 80px;
            padding: 6px 10px;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            background: rgba(0, 0, 0, 0.3);
            color: #fff;
            font-size: 13px;
            text-align: center;
            outline: none;
            transition: 0.2s;
        }
        .toki-input:focus {
            border-color: #818cf8;
            box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.2);
        }
        .toki-select {
            width: 100%;
            padding: 8px 12px;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            background: #1e293b;
            color: #fff;
            font-size: 13px;
            outline: none;
            cursor: pointer;
        }
        .toki-folder-box {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }
        .toki-folder-path {
            font-size: 12px;
            color: #cbd5e1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex: 1;
            background: rgba(0, 0, 0, 0.2);
            padding: 6px 10px;
            border-radius: 6px;
            border: 1px dashed rgba(255, 255, 255, 0.15);
        }
        .toki-folder-btn {
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            color: #fff;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            white-space: nowrap;
            transition: 0.2s;
        }
        .toki-folder-btn:hover {
            background: rgba(255, 255, 255, 0.2);
        }
        /* 프로그레스 바 */
        .toki-progress-card {
            background: rgba(99, 102, 241, 0.08);
            border: 1px solid rgba(99, 102, 241, 0.2);
            border-radius: 12px;
            padding: 14px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .toki-progress-header {
            display: flex;
            justify-content: space-between;
            font-size: 13px;
            font-weight: 700;
        }
        .toki-progress-bar-bg {
            width: 100%;
            height: 10px;
            background: rgba(0, 0, 0, 0.4);
            border-radius: 10px;
            overflow: hidden;
            position: relative;
        }
        .toki-progress-bar-fill {
            height: 100%;
            width: 0%;
            background: linear-gradient(90deg, #6366f1, #a855f7, #ec4899);
            border-radius: 10px;
            transition: width 0.3s ease;
        }
        .toki-progress-status {
            font-size: 12px;
            color: #94a3b8;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        /* 액션 버튼 */
        .toki-actions {
            display: flex;
            gap: 8px;
            margin-top: 4px;
        }
        .toki-btn {
            flex: 1;
            padding: 12px;
            border-radius: 10px;
            font-size: 14px;
            font-weight: 700;
            cursor: pointer;
            border: none;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }
        .toki-btn-primary {
            background: linear-gradient(135deg, #6366f1, #a855f7);
            color: #fff;
            box-shadow: 0 4px 16px rgba(99, 102, 241, 0.3);
        }
        .toki-btn-primary:hover {
            opacity: 0.95;
            transform: translateY(-1px);
        }
        .toki-btn-primary:disabled {
            background: #475569;
            color: #94a3b8;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
        }
        .toki-btn-danger {
            background: rgba(239, 68, 68, 0.2);
            border: 1px solid rgba(239, 68, 68, 0.4);
            color: #fca5a5;
        }
        .toki-btn-danger:hover {
            background: rgba(239, 68, 68, 0.35);
        }
        .toki-log-box {
            font-family: Consolas, monospace;
            font-size: 11px;
            background: rgba(0, 0, 0, 0.4);
            border-radius: 8px;
            padding: 8px 10px;
            max-height: 80px;
            overflow-y: auto;
            color: #94a3b8;
            line-height: 1.4;
        }
    `;

    // =============================================================
    // 🚀 Iframe 추출 헬퍼 (Shadow DOM & 레거시 지원)
    // =============================================================
    function extractFromIframe(iframe, src) {
        return new Promise((resolve) => {
            let isResolved = false;
            const timeout = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    resolve('');
                }
            }, 15000);

            const onLoad = async () => {
                iframe.removeEventListener('load', onLoad);
                let content = '';

                for (let attempt = 0; attempt < 25; attempt++) {
                    await sleep(400);
                    try {
                        const iDoc = iframe.contentWindow?.document;
                        if (!iDoc) continue;

                        // 1. Shadow DOM 파싱 (tokiSync 규격)
                        const host = iDoc.querySelector('[data-theme-novel-content]') ||
                                     iDoc.querySelector('.theme-novel-content') ||
                                     iDoc.querySelector('.novel-epub-rendered')?.getRootNode()?.host ||
                                     iDoc.querySelector('#novel_content')?.getRootNode()?.host;

                        if (host && host.shadowRoot) {
                            const pTags = host.shadowRoot.querySelectorAll('.novel-epub-rendered p, p');
                            if (pTags.length > 0) {
                                content = Array.from(pTags)
                                    .map(p => p.textContent.trim())
                                    .filter(t => t.length > 0)
                                    .join('\n\n');
                            } else {
                                const nonStyle = Array.from(host.shadowRoot.children).filter(c => c.tagName !== 'STYLE' && c.tagName !== 'SCRIPT');
                                const pTexts = nonStyle.map(c => (c.innerText || c.textContent || '').trim()).filter(t => t.length > 0);
                                if (pTexts.length > 0) content = pTexts.join('\n\n');
                            }
                        }

                        // 2. 레거시 엘리먼트 파싱
                        if (!content || content.length < 30) {
                            const legacy = iDoc.querySelector('#novel_content');
                            if (legacy && legacy.innerText && legacy.innerText.trim().length > 30) {
                                content = legacy.innerText.trim();
                            }
                        }

                        if (content && content.length > 30) {
                            break;
                        }
                    } catch (e) {
                        // 크로스 오리진 등의 경우 대기
                    }
                }

                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeout);
                    resolve(cleanNovelText(content));
                }
            };

            iframe.addEventListener('load', onLoad);
            iframe.src = src;
        });
    }

    // =============================================================
    // 🚀 GUI 관리자 및 다운로더 컨트롤러
    // =============================================================
    class TokiNovelGui {
        constructor() {
            this.episodes = [];
            this.seriesInfo = getSeriesInfo();
            this.seriesTitle = this.seriesInfo.title;
            this.author = this.seriesInfo.author;
            this.genre = this.seriesInfo.firstGenre;
            this.isDownloading = false;
            this.abortFlag = false;
            this.selectedDirectoryHandle = null;

            this.injectStyles();
            this.renderUI();
            this.attachEvents();
            this.loadInitialEpisodes();
        }

        injectStyles() {
            const style = document.createElement('style');
            style.textContent = UI_STYLE;
            document.head.appendChild(style);
        }

        renderUI() {
            // 1. 플로팅 런처 버튼
            const launcher = document.createElement('button');
            launcher.id = 'toki-gui-launcher';
            launcher.innerHTML = `📥 <span>소설 다운로더</span>`;
            document.body.appendChild(launcher);

            // 2. 모달 컨테이너
            const modal = document.createElement('div');
            modal.id = 'toki-gui-modal';
            modal.innerHTML = `
                <div class="toki-header">
                    <div class="toki-title">
                        <span>📚</span> Toki Novel Downloader
                    </div>
                    <button class="toki-close-btn" id="toki-btn-close">✕</button>
                </div>
                <div class="toki-body">
                    <!-- 소설 정보 -->
                    <div class="toki-card">
                        <div class="toki-card-title">소설 정보</div>
                        <div class="toki-series-name" id="toki-ui-title" title="${escapeXml(this.seriesTitle)}">${escapeXml(this.seriesTitle)}</div>
                        <div style="font-size: 12px; color: #94a3b8; margin-bottom: 6px;">
                            ${this.author ? `✍️ 작가: <b style="color:#e2e8f0;">${escapeXml(this.author)}</b>` : ''} 
                            ${this.genre ? `&nbsp;|&nbsp; 🏷️ 장르: <b style="color:#e2e8f0;">${escapeXml(this.genre)}</b>` : ''}
                        </div>
                        <div class="toki-series-meta">
                            <span id="toki-ui-count">감지된 회차: 로딩 중...</span>
                            <button class="toki-scan-btn" id="toki-btn-rescan">전체 목록 재스캔</button>
                        </div>
                    </div>

                    <!-- 다운로드 범위 -->
                    <div class="toki-card">
                        <div class="toki-card-title">다운로드 범위</div>
                        <div class="toki-radio-group">
                            <label class="toki-radio-item">
                                <input type="radio" name="toki-range-type" value="all" checked>
                                <span>전체 다운로드 (<span id="toki-ui-all-text">1화 ~ ?화</span>)</span>
                            </label>
                            <label class="toki-radio-item">
                                <input type="radio" name="toki-range-type" value="custom">
                                <span>일부 범위 지정</span>
                            </label>
                            <div class="toki-range-inputs" id="toki-range-inputs-box" style="opacity: 0.5;">
                                <input type="number" class="toki-input" id="toki-input-start" value="1" min="1" disabled>
                                <span>화 ~</span>
                                <input type="number" class="toki-input" id="toki-input-last" value="1" min="1" disabled>
                                <span>화</span>
                            </div>
                        </div>
                    </div>

                    <!-- 저장 설정 -->
                    <div class="toki-card">
                        <div class="toki-card-title">저장 형식 및 옵션</div>
                        <div style="display: flex; flex-direction: column; gap: 10px;">
                            <div>
                                <select class="toki-select" id="toki-select-format">
                                    <option value="single-txt" selected>📄 통합 텍스트 파일 (.txt - 작가/장르 포함)</option>
                                    <option value="zip-txt">📦 회차별 텍스트 압축 (.zip)</option>
                                    <option value="epub">📖 표준 전자책 (.epub)</option>
                                </select>
                            </div>
                            <!-- 로컬 폴더 지정 -->
                            <div class="toki-folder-box">
                                <div class="toki-folder-path" id="toki-ui-folder-path">저장 위치: 기본 다운로드 폴더</div>
                                <button class="toki-folder-btn" id="toki-btn-select-folder">📁 폴더 지정</button>
                            </div>
                            <!-- 지터 속도 모드 -->
                            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #94a3b8;">
                                <span>🛡️ IP 보호 딜레이:</span>
                                <select class="toki-select" id="toki-select-delay" style="width: auto; padding: 4px 8px; font-size: 12px;">
                                    <option value="safe" selected>안전 권장 (1.5s~2.5s 지터)</option>
                                    <option value="very_safe">매우 신중 (3.0s~4.5s 지터)</option>
                                    <option value="fast">빠름 (0.8s~1.2s)</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <!-- 실시간 진행바 -->
                    <div class="toki-progress-card" id="toki-progress-card">
                        <div class="toki-progress-header">
                            <span id="toki-ui-progress-text">진행 상태: 대기 중</span>
                            <span id="toki-ui-percent" style="color: #a855f7;">0%</span>
                        </div>
                        <div class="toki-progress-bar-bg">
                            <div class="toki-progress-bar-fill" id="toki-ui-bar-fill"></div>
                        </div>
                        <div class="toki-progress-status" id="toki-ui-current-task">준비 완료</div>
                    </div>

                    <!-- 로그 콘솔 -->
                    <div class="toki-log-box" id="toki-log-box">
                        [시스템] GUI 초기화 완료. 소설 목록을 확인해주세요.
                    </div>

                    <!-- 액션 버튼 -->
                    <div class="toki-actions">
                        <button class="toki-btn toki-btn-primary" id="toki-btn-start">
                            ▶ 다운로드 시작
                        </button>
                        <button class="toki-btn toki-btn-danger" id="toki-btn-stop" style="display: none;">
                            ⏹ 중단
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            this.launcher = launcher;
            this.modal = modal;
        }

        log(msg) {
            const box = document.getElementById('toki-log-box');
            if (box) {
                const item = document.createElement('div');
                item.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
                box.appendChild(item);
                box.scrollTop = box.scrollHeight;
            }
            console.log(`[TokiGUI] ${msg}`);
        }

        async loadInitialEpisodes() {
            this.episodes = parseEpisodesFromDoc(document).sort((a, b) => a.num - b.num);
            this.updateEpisodeMeta();
        }

        updateEpisodeMeta() {
            const countEl = document.getElementById('toki-ui-count');
            const allTextEl = document.getElementById('toki-ui-all-text');
            const startInput = document.getElementById('toki-input-start');
            const lastInput = document.getElementById('toki-input-last');

            if (this.episodes.length > 0) {
                const minNum = this.episodes[0].num;
                const maxNum = this.episodes[this.episodes.length - 1].num;

                countEl.innerText = `총 ${this.episodes.length}화 감지됨`;
                allTextEl.innerText = `${minNum}화 ~ ${maxNum}화`;

                startInput.min = minNum;
                startInput.max = maxNum;
                startInput.value = minNum;

                lastInput.min = minNum;
                lastInput.max = maxNum;
                lastInput.value = maxNum;
            } else {
                countEl.innerText = '회차 감지 실패 (목록 페이지인지 확인)';
            }
        }

        attachEvents() {
            // 열기 / 닫기
            this.launcher.addEventListener('click', () => {
                const isHidden = this.modal.style.display === 'none' || !this.modal.style.display;
                this.modal.style.display = isHidden ? 'flex' : 'none';
            });
            document.getElementById('toki-btn-close').addEventListener('click', () => {
                this.modal.style.display = 'none';
            });

            // 전체 재스캔
            document.getElementById('toki-btn-rescan').addEventListener('click', async () => {
                this.log('전체 페이지 회차 스캔을 시작합니다...');
                document.getElementById('toki-ui-count').innerText = '스캔 중...';
                this.episodes = await fetchAllEpisodePages(msg => this.log(msg));
                this.updateEpisodeMeta();
                this.log(`스캔 완료: 총 ${this.episodes.length}개의 회차를 확보했습니다.`);
            });

            // 범위 라디오 버튼 전환
            const radios = document.querySelectorAll('input[name="toki-range-type"]');
            const rangeBox = document.getElementById('toki-range-inputs-box');
            const startInput = document.getElementById('toki-input-start');
            const lastInput = document.getElementById('toki-input-last');

            radios.forEach(r => {
                r.addEventListener('change', e => {
                    const isCustom = e.target.value === 'custom';
                    rangeBox.style.opacity = isCustom ? '1' : '0.5';
                    startInput.disabled = !isCustom;
                    lastInput.disabled = !isCustom;
                });
            });

            // 폴더 지정 (File System Access API)
            document.getElementById('toki-btn-select-folder').addEventListener('click', async () => {
                if (!window.showDirectoryPicker) {
                    alert('현재 브라우저에서는 폴더 직접 지정(File System Access API)을 지원하지 않습니다.\n다운로드 시 브라우저 기본 다운로드 폴더로 자동 저장됩니다.');
                    return;
                }
                try {
                    this.selectedDirectoryHandle = await window.showDirectoryPicker();
                    document.getElementById('toki-ui-folder-path').innerText = `저장 폴더: 📁 ${this.selectedDirectoryHandle.name}`;
                    this.log(`로컬 저장 경로 지정됨: 📁 ${this.selectedDirectoryHandle.name}`);
                } catch (e) {
                    if (e.name !== 'AbortError') {
                        this.log(`폴더 선택 오류: ${e.message}`);
                    }
                }
            });

            // 시작 / 중단 버튼
            document.getElementById('toki-btn-start').addEventListener('click', () => {
                if (this.isDownloading) return;
                this.startDownload();
            });

            document.getElementById('toki-btn-stop').addEventListener('click', () => {
                if (confirm('다운로드를 중단하시겠습니까?')) {
                    this.abortFlag = true;
                    this.log('사용자 요청으로 다운로드 중단 신호를 보냈습니다.');
                }
            });
        }

        async startDownload() {
            if (this.episodes.length === 0) {
                alert('다운로드할 회차 목록이 없습니다. 목록을 다시 스캔해주세요.');
                return;
            }

            const rangeType = document.querySelector('input[name="toki-range-type"]:checked').value;
            let targetEpisodes = [...this.episodes];

            let startNum = targetEpisodes[0].num;
            let lastNum = targetEpisodes[targetEpisodes.length - 1].num;

            if (rangeType === 'custom') {
                const sVal = parseInt(document.getElementById('toki-input-start').value, 10) || startNum;
                const lVal = parseInt(document.getElementById('toki-input-last').value, 10) || lastNum;
                startNum = Math.min(sVal, lVal);
                lastNum = Math.max(sVal, lVal);

                targetEpisodes = targetEpisodes.filter(ep => ep.num >= startNum && ep.num <= lastNum);
            }

            if (targetEpisodes.length === 0) {
                alert('선택한 범위에 해당하는 회차가 없습니다.');
                return;
            }

            const format = document.getElementById('toki-select-format').value;
            const delayMode = document.getElementById('toki-select-delay').value;
            let baseDelay = 1500;
            let jitterDelay = 1000;
            if (delayMode === 'very_safe') { baseDelay = 3000; jitterDelay = 1500; }
            else if (delayMode === 'fast') { baseDelay = 800; jitterDelay = 400; }

            // UI 상태 변경
            this.isDownloading = true;
            this.abortFlag = false;
            document.getElementById('toki-btn-start').disabled = true;
            document.getElementById('toki-btn-stop').style.display = 'flex';
            startAntiSleep();

            this.log(`다운로드 시작: 총 ${targetEpisodes.length}화 (${startNum}화 ~ ${lastNum}화, 포맷: ${format})`);

            // Iframe 생성
            const iframe = document.createElement('iframe');
            iframe.style.width = '1px';
            iframe.style.height = '1px';
            iframe.style.opacity = '0.01';
            iframe.style.position = 'fixed';
            iframe.style.bottom = '0';
            iframe.style.left = '0';
            document.body.appendChild(iframe);

            const collectedChapters = []; // { num, title, content }
            const totalCount = targetEpisodes.length;

            const progressBar = document.getElementById('toki-ui-bar-fill');
            const progressText = document.getElementById('toki-ui-progress-text');
            const percentText = document.getElementById('toki-ui-percent');
            const currentTaskText = document.getElementById('toki-ui-current-task');

            try {
                for (let i = 0; i < totalCount; i++) {
                    if (this.abortFlag) {
                        this.log('다운로드가 중단되었습니다.');
                        break;
                    }

                    const ep = targetEpisodes[i];
                    const currentIdx = i + 1;
                    const percent = Math.round((i / totalCount) * 100);

                    // 진행 상태 갱신
                    progressText.innerText = `진행: ${currentIdx} / ${totalCount}화`;
                    percentText.innerText = `${percent}%`;
                    progressBar.style.width = `${percent}%`;
                    currentTaskText.innerText = `⏳ [${ep.num}화] ${ep.title} 수집 중...`;

                    this.log(`[${currentIdx}/${totalCount}] ${ep.title} 추출 중...`);

                    // 본문 추출
                    const content = await extractFromIframe(iframe, ep.url);

                    if (content && content.length > 20) {
                        collectedChapters.push({
                            num: ep.num,
                            title: ep.title,
                            content: content
                        });
                        this.log(`✅ [${ep.num}화] 추출 완료 (${content.length}자)`);
                    } else {
                        this.log(`⚠️ [${ep.num}화] 본문 추출 실패 (건너뜀)`);
                    }

                    // 안전 지터 딜레이
                    if (i < totalCount - 1) {
                        const waitTime = baseDelay + Math.random() * jitterDelay;
                        await sleep(waitTime);
                    }
                }

                // 100% 완료 상태 표시
                progressBar.style.width = '100%';
                percentText.innerText = '100%';
                progressText.innerText = `완료: ${collectedChapters.length} / ${totalCount}화`;
                currentTaskText.innerText = '🎉 파일 생성 및 저장 중...';

                // =========================================================
                // 💾 파일 생성 및 저장
                // =========================================================
                if (collectedChapters.length > 0) {
                    const isAll = (rangeType === 'all' || (this.episodes.length > 0 && startNum === this.episodes[0].num && lastNum === this.episodes[this.episodes.length - 1].num));
                    const rangeLabel = isAll ? '' : `${startNum}화~${lastNum}화`;

                    // 1) 통합 텍스트 파일 (.txt)
                    if (format === 'single-txt') {
                        let finalBody = '';

                        collectedChapters.forEach(c => {
                            finalBody += `${c.title}\n\n`;
                            finalBody += `${c.content}\n\n\n`;
                        });

                        const fileName = formatNovelFileName(this.seriesTitle, this.author, this.genre, rangeLabel);
                        await this.saveFile(fileName, finalBody, 'text/plain;charset=utf-8');
                        this.log(`📄 통합 텍스트 저장 완료: ${fileName}`);
                    }
                    // 2) 회차별 분할 압축 파일 (.zip)
                    else if (format === 'zip-txt') {
                        const zip = new JSZip();

                        collectedChapters.forEach(c => {
                            const padNum = String(c.num).padStart(4, '0');
                            const safeChapterTitle = sanitizeFilename(c.title);
                            zip.file(`${padNum} ${safeChapterTitle}.txt`, c.content);
                        });

                        const zipBlob = await zip.generateAsync({ type: 'blob' });
                        const fileName = formatNovelFileName(this.seriesTitle, this.author, this.genre, rangeLabel).replace(/\.txt$/, '.zip');
                        await this.saveBlob(fileName, zipBlob);
                        this.log(`📦 회차별 압축 저장 완료: ${fileName}`);
                    }
                    // 3) 전자책 (.epub)
                    else if (format === 'epub') {
                        const epubBlob = await this.buildEpubBlob(this.seriesTitle, collectedChapters, startNum, lastNum);
                        const fileName = formatNovelFileName(this.seriesTitle, this.author, this.genre, rangeLabel).replace(/\.txt$/, '.epub');
                        await this.saveBlob(fileName, epubBlob);
                        this.log(`📖 EPUB 전자책 저장 완료: ${fileName}`);
                    }

                    currentTaskText.innerText = '✨ 모든 저장이 완료되었습니다!';
                } else {
                    currentTaskText.innerText = '수집된 본문이 없습니다.';
                }

            } catch (err) {
                this.log(`❌ 오류 발생: ${err.message}`);
                console.error(err);
            } finally {
                iframe.remove();
                stopAntiSleep();
                this.isDownloading = false;
                document.getElementById('toki-btn-start').disabled = false;
                document.getElementById('toki-btn-stop').style.display = 'none';
            }
        }

        // =========================================================
        // 💾 저장 헬퍼 (File System Access API & Fallback)
        // =========================================================
        async saveFile(fileName, textContent, mimeType) {
            const blob = new Blob([textContent], { type: mimeType });
            await this.saveBlob(fileName, blob);
        }

        async saveBlob(fileName, blob) {
            // 1. 사용자가 지정한 폴더가 있을 때 (File System Access API)
            if (this.selectedDirectoryHandle) {
                try {
                    const fileHandle = await this.selectedDirectoryHandle.getFileHandle(fileName, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    this.log(`📁 로컬 지정 폴더에 직접 저장 성공: ${fileName}`);
                    return;
                } catch (e) {
                    this.log(`폴더 직접 쓰기 실패 -> 브라우저 기본 다운로드로 전환: ${e.message}`);
                }
            }

            // 2. 브라우저 기본 다운로드 Fallback
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }

        // EPUB 빌더
        async buildEpubBlob(title, chapters, startNum, lastNum) {
            const zip = new JSZip();
            const safeTitle = escapeXml(title);
            const uid = "urn:uuid:" + (crypto.randomUUID ? crypto.randomUUID() : Date.now());

            zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

            zip.folder("META-INF").file("container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>`);

            const oebps = zip.folder("OEBPS");
            oebps.file("styles.css", `body { font-family: sans-serif; line-height: 1.8; } p { text-indent: 1em; margin-bottom: 0.8em; } h2 { text-align: center; margin: 1.5em 0; }`);

            // 목차 챕터 생성
            let tocHtml = `<h2>[ 목차 ]</h2><div style="line-height: 2;">`;
            chapters.forEach(c => {
                tocHtml += `<div>${escapeXml(c.title)}</div>`;
            });
            tocHtml += `</div>`;

            oebps.file("toc_page.xhtml", `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>목차</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body>${tocHtml}</body></html>`);

            // 본문 챕터들
            chapters.forEach((c, idx) => {
                const paragraphs = c.content.split('\n')
                    .map(l => l.trim())
                    .filter(l => l.length > 0)
                    .map(l => `<p>${escapeXml(l)}</p>`)
                    .join('\n');

                const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(c.title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body><h2>${escapeXml(c.title)}</h2>${paragraphs}</body></html>`;

                oebps.file(`chapter_${idx + 1}.xhtml`, xhtml);
            });

            // manifest, spine, tocNav
            let manifest = `<item id="style" href="styles.css" media-type="text/css"/>\n`;
            manifest += `<item id="toc_page" href="toc_page.xhtml" media-type="application/xhtml+xml"/>\n`;
            let spine = `<itemref idref="toc_page"/>\n`;
            let tocNav = `<navPoint id="toc_page" playOrder="1"><navLabel><text>목차</text></navLabel><content src="toc_page.xhtml"/></navPoint>\n`;

            chapters.forEach((c, idx) => {
                const id = `chap${idx + 1}`;
                const href = `chapter_${idx + 1}.xhtml`;
                manifest += `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>\n`;
                spine += `<itemref idref="${id}"/>\n`;
                tocNav += `<navPoint id="${id}" playOrder="${idx + 2}"><navLabel><text>${escapeXml(c.title)}</text></navLabel><content src="${href}"/></navPoint>\n`;
            });
            manifest += `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`;

            const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
        <dc:title>${safeTitle} (${startNum}화~${lastNum}화)</dc:title>
        <dc:language>ko</dc:language>
        <dc:identifier id="BookId">${uid}</dc:identifier>
    </metadata>
    <manifest>${manifest}</manifest>
    <spine toc="ncx">${spine}</spine>
</package>`;
            oebps.file("content.opf", opf);

            const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${uid}"/><meta name="dtb:depth" content="1"/></head>
<docTitle><text>${safeTitle}</text></docTitle>
<navMap>${tocNav}</navMap>
</ncx>`;
            oebps.file("toc.ncx", ncx);

            return await zip.generateAsync({ type: "blob" });
        }
    }

    // =============================================================
    // 🏁 시작 진입점
    // =============================================================
    function initGui() {
        if (siteType === 'novel') {
            if (document.getElementById('toki-gui-launcher')) return;
            new TokiNovelGui();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGui);
    } else {
        initGui();
    }

    // 메뉴 명령 등록
    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('📥 소설 다운로더 열기', () => {
            const modal = document.getElementById('toki-gui-modal');
            if (modal) modal.style.display = 'flex';
        });
    }

})();