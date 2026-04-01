/**
 * E2E 테스트 헬퍼 — Puppeteer + Chrome CDP
 *
 * 모드 (CLI 옵션 --mode):
 *   --mode=host    : 호스트 Windows Chrome CDP에 연결 (기본)
 *   --mode=headless: WSL2 내부 headless Chrome 실행
 *
 * 예시:
 *   node e2e/text-flow.test.mjs                  # 호스트 Chrome CDP
 *   node e2e/text-flow.test.mjs --mode=headless  # headless Chrome
 */
import puppeteer from 'puppeteer-core';

const CHROME_PATH = '/home/edward/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome';
const CHROME_CDP = process.env.CHROME_CDP || 'http://172.21.192.1:19222';
const VITE_URL = process.env.VITE_URL || 'http://localhost:7700';

/** CLI 인수에서 --mode=host|headless 파싱 */
function parseMode() {
  const modeArg = process.argv.find(a => a.startsWith('--mode='));
  if (modeArg) return modeArg.split('=')[1];
  return 'host';
}

const MODE = parseMode();

// ─── 브라우저/페이지 생명주기 ────────────────────────────

/** Chrome 브라우저에 연결하거나 시작하고 반환 */
export async function launchBrowser() {
  if (MODE === 'headless') {
    console.log('  [browser] headless Chrome 실행');
    return await puppeteer.launch({
      headless: true,
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
  }
  // 호스트 Chrome CDP에 연결
  console.log(`  [browser] 호스트 Chrome CDP 연결 (${CHROME_CDP})`);
  const browser = await puppeteer.connect({
    browserURL: CHROME_CDP,
    defaultViewport: null,
  });
  browser._isRemote = true;
  return browser;
}

/** 테스트용 페이지 생성 + 크기 설정
 * host 모드: 기본 1280x750 (윈도우 외곽 크기)
 * headless 모드: 기본 1280x900 (뷰포트)
 */
export async function createPage(browser, width, height) {
  if (!browser._testPages) browser._testPages = [];

  if (MODE === 'headless') {
    const page = await browser.newPage();
    await page.setViewport({ width: width || 1280, height: height || 900 });
    browser._testPages.push(page);
    return page;
  }
  // host 모드: 새 탭 열기 + 윈도우 크기 설정
  const page = await browser.newPage();
  browser._testPages.push(page);
  const w = width || 1280;
  const h = height || 750;
  const session = await page.createCDPSession();
  const { windowId } = await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds', {
    windowId, bounds: { width: w, height: h, windowState: 'normal' },
  });
  await new Promise(r => setTimeout(r, 300));
  await session.detach();
  return page;
}

/** 페이지(탭) 정리 */
export async function closePage(page) {
  await page.close();
}

/** 브라우저 정리 — 테스트 탭 닫기 + CDP disconnect 또는 headless close */
export async function closeBrowser(browser) {
  if (browser._isRemote) {
    if (browser._testPages) {
      for (const p of browser._testPages) {
        await p.close().catch(() => {});
      }
      browser._testPages = [];
    }
    browser.disconnect();
  } else {
    await browser.close();
  }
}

// ─── 앱/문서 로드 ────────────────────────────────────────

/** 편집 영역 캔버스 셀렉터 (숨겨진 스크롤바 캔버스 제외) */
const CANVAS_SELECTOR = '#scroll-container canvas';

/** Vite dev server에서 앱을 로드하고 WASM 초기화 완료 대기 */
export async function loadApp(page) {
  await page.goto(VITE_URL, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForFunction(() => !!window.__wasm, { timeout: 15000 });
  await page.evaluate(() => new Promise(r => setTimeout(r, 500)));
}

/** 편집 영역 캔버스가 렌더링될 때까지 대기 */
export async function waitForCanvas(page, timeout = 10000) {
  await page.waitForSelector(CANVAS_SELECTOR, { timeout });
}

/** 새 빈 문서 생성 + 캔버스 대기 */
export async function createNewDocument(page) {
  await page.evaluate(() => window.__eventBus?.emit('create-new-document'));
  await page.waitForSelector(CANVAS_SELECTOR, { timeout: 10000 });
  await page.evaluate(() => new Promise(r => setTimeout(r, 1000)));
}

/** HWP 파일을 fetch하여 문서 로드 + 캔버스 대기 */
export async function loadHwpFile(page, filename) {
  const result = await page.evaluate(async (fname) => {
    try {
      const resp = await fetch(`/samples/${fname}`);
      if (!resp.ok) return { error: `HTTP ${resp.status}` };
      const buf = await resp.arrayBuffer();
      const docInfo = window.__wasm?.loadDocument(new Uint8Array(buf), fname);
      if (!docInfo) return { error: 'loadDocument returned null' };
      window.__canvasView?.loadDocument?.();
      return { pageCount: docInfo.pageCount };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }, filename);
  if (result.error) throw new Error(`파일 로드 실패 (${filename}): ${result.error}`);
  await page.waitForSelector(CANVAS_SELECTOR, { timeout: 10000 });
  await page.evaluate(() => new Promise(r => setTimeout(r, 1500)));
  return result;
}

// ─── 편집/입력 ────────────────────────────────────────────

/** 편집 영역(캔버스) 클릭하여 포커스 */
export async function clickEditArea(page) {
  const canvas = await page.$(CANVAS_SELECTOR);
  if (!canvas) throw new Error('편집 영역 캔버스를 찾을 수 없습니다');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('캔버스 boundingBox가 null입니다');
  await page.mouse.click(box.x + box.width / 2, box.y + 100);
  await page.evaluate(() => new Promise(r => setTimeout(r, 200)));
}

/** 키보드로 텍스트 입력 */
export async function typeText(page, text) {
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 30 });
  }
  await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
}

// ─── 스크린샷/조회/검증 ──────────────────────────────────

/** 스크린샷을 파일로 저장 */
export async function screenshot(page, name) {
  const dir = 'e2e/screenshots';
  const { mkdirSync, existsSync } = await import('fs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = `${dir}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log(`  Screenshot: ${path}`);
  return path;
}

/** WASM bridge를 통해 페이지 수 조회 */
export async function getPageCount(page) {
  return await page.evaluate(() => window.__wasm?.pageCount ?? 0);
}

/** WASM bridge를 통해 문단 수 조회 */
export async function getParagraphCount(page, sectionIdx = 0) {
  return await page.evaluate((sec) => window.__wasm?.getParagraphCount(sec) ?? -1, sectionIdx);
}

/** WASM bridge를 통해 문단 텍스트 조회 */
export async function getParaText(page, secIdx, paraIdx, maxLen = 200) {
  return await page.evaluate((s, p, m) => {
    try { return window.__wasm?.getTextRange(s, p, 0, m) ?? ''; }
    catch { return ''; }
  }, secIdx, paraIdx, maxLen);
}

/** 테스트 결과 출력 헬퍼 */
export function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    process.exitCode = 1;
  }
}

// ─── 테스트 러너 ─────────────────────────────────────────

/**
 * 테스트 실행 래퍼 — 공통 골격 (브라우저/페이지 생명주기 + 에러 처리)
 *
 * 사용법:
 *   runTest('테스트 제목', async ({ page, browser }) => {
 *     await createNewDocument(page);
 *     // ... 테스트 로직
 *   });
 */
export async function runTest(title, testFn, { skipLoadApp = false } = {}) {
  console.log(`=== E2E: ${title} ===\n`);
  const browser = await launchBrowser();
  const page = await createPage(browser);

  try {
    if (!skipLoadApp) await loadApp(page);
    await testFn({ page, browser });
  } catch (err) {
    console.error('테스트 오류:', err.message || err);
    await screenshot(page, 'error').catch(() => {});
    process.exitCode = 1;
  } finally {
    await closeBrowser(browser);
  }
}
