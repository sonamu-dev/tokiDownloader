import JSZip from 'jszip';
import fs from 'node:fs';

function escapeXml(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe.replace(/[<>&'"]/g, function (c) {
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

export class EpubBuilder {
    constructor() {
        this.chapters = [];
    }

    addChapter(title, textContent) {
        const htmlContent = textContent
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => `<p>${escapeXml(line)}</p>`)
            .join('\n');

        this.chapters.push({
            title: escapeXml(title),
            rawTitle: title,
            content: htmlContent
        });
    }

    async build(metadata = {}) {
        const zip = new JSZip();
        const title = escapeXml(metadata.title || "제목 없음");
        const author = escapeXml(metadata.author || "미상");
        const uid = "urn:uuid:" + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : (Date.now() + "-" + Math.random().toString(36).substring(2)));

        // 1. mimetype (무압축 필수)
        zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

        // 2. container.xml
        zip.folder("META-INF").file("container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>`);

        // 3. OEBPS 폴더
        const oebps = zip.folder("OEBPS");

        // 스타일시트 (한국어 이북 가독성 최적화)
        oebps.file("styles.css", `
body {
    font-family: "KoPubWorldBatang", "Noto Serif CJK KR", "Batang", "Malgun Gothic", serif;
    font-size: 1.05em;
    line-height: 1.8;
    margin: 5%;
    padding: 0;
    color: #1a1a1a;
}
h2 {
    font-size: 1.4em;
    font-weight: bold;
    text-align: center;
    margin-top: 1.5em;
    margin-bottom: 1.5em;
    padding-bottom: 0.5em;
    border-bottom: 1px solid #ddd;
}
p {
    text-indent: 1em;
    margin-top: 0;
    margin-bottom: 0.8em;
    word-break: break-all;
}
`);

        // 챕터별 XHTML 생성
        this.chapters.forEach((chapter, index) => {
            const filename = `chapter_${index + 1}.xhtml`;
            const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ko">
<head>
    <title>${chapter.title}</title>
    <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
    <h2>${chapter.title}</h2>
    ${chapter.content}
</body>
</html>`;
            oebps.file(filename, xhtml);
        });

        // content.opf
        let manifest = `        <item id="style" href="styles.css" media-type="text/css"/>\n`;
        let spine = ``;
        let tocNav = `    <navMap>\n`;

        this.chapters.forEach((c, i) => {
            const id = `chap${i + 1}`;
            const href = `chapter_${i + 1}.xhtml`;
            manifest += `        <item id="${id}" href="${href}" media-type="application/xhtml+xml"/>\n`;
            spine += `        <itemref idref="${id}"/>\n`;
            tocNav += `        <navPoint id="${id}" playOrder="${i + 1}">
            <navLabel><text>${c.title}</text></navLabel>
            <content src="${href}"/>
        </navPoint>\n`;
        });
        manifest += `        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`;
        tocNav += `    </navMap>`;

        const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
        <dc:title>${title}</dc:title>
        <dc:creator opf:role="aut">${author}</dc:creator>
        <dc:language>ko</dc:language>
        <dc:identifier id="BookId">${uid}</dc:identifier>
    </metadata>
    <manifest>
${manifest}
    </manifest>
    <spine toc="ncx">
${spine}
    </spine>
</package>`;

        oebps.file("content.opf", opf);

        // toc.ncx (목차)
        const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
    <head>
        <meta name="dtb:uid" content="${uid}"/>
        <meta name="dtb:depth" content="1"/>
        <meta name="dtb:totalPageCount" content="0"/>
        <meta name="dtb:maxPageNumber" content="0"/>
    </head>
    <docTitle><text>${title}</text></docTitle>
${tocNav}
</ncx>`;

        oebps.file("toc.ncx", ncx);

        const buffer = await zip.generateAsync({
            type: "nodebuffer",
            mimeType: "application/epub+zip",
            compression: "DEFLATE",
            compressionOptions: { level: 9 }
        });

        return buffer;
    }

    async saveToFile(filePath, metadata = {}) {
        const buffer = await this.build(metadata);
        const dir = filePath.substring(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
        if (dir && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, buffer);
    }
}
