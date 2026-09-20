/**
 * Короткий прогон PULSE через Playwright: меню → игра → импульсы → пауза.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.PULSE_URL || 'http://127.0.0.1:3004/';
const outDir = path.resolve('tmp-play');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });

const log = [];
const note = (msg) => {
  log.push(msg);
  console.log(msg);
};

try {
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 20000 });
  note(`opened ${URL} title=${await page.title()}`);

  const play = page.locator('#btn-dual');
  await play.waitFor({ state: 'visible', timeout: 10000 });
  note('menu visible, clicking ИГРАТЬ (dual)');
  await play.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, '01-after-play.png') });

  const hud = page.locator('#hud');
  const hudHidden = await hud.isHidden();
  note(`hud hidden=${hudHidden}`);

  // Несколько импульсов по полю и с клавиатуры.
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(280);
  }
  await page.screenshot({ path: path.join(outDir, '02-after-pulses.png') });

  const score = await page.locator('#hud-score').textContent();
  const time = await page.locator('#hud-time').textContent();
  const mode = await page.locator('#hud-mode').textContent();
  const energy = await page.locator('#hud-energy').getAttribute('style');
  note(`hud score=${score} time=${time} mode=${mode} energyStyle=${energy}`);

  await page.locator('#btn-pause').click();
  await page.waitForTimeout(300);
  const pauseVisible = await page.locator('#pause').isVisible();
  note(`pause panel visible=${pauseVisible}`);
  await page.screenshot({ path: path.join(outDir, '03-pause.png') });

  if (pauseVisible) {
    await page.locator('#btn-resume').click();
    await page.waitForTimeout(200);
    note('resumed');
  }

  // Ещё импульсы, пока не game over или ~6 секунд.
  for (let i = 0; i < 20; i += 1) {
    const over = await page.locator('#over').isVisible();
    if (over) {
      note('game over reached');
      break;
    }
    await page.mouse.click(450, 350);
    await page.waitForTimeout(350);
  }

  await page.screenshot({ path: path.join(outDir, '04-end.png') });
  const overVisible = await page.locator('#over').isVisible();
  const finalScore = overVisible
    ? await page.locator('#over-score').textContent()
    : await page.locator('#hud-score').textContent();
  note(`finished over=${overVisible} score=${finalScore}`);

  fs.writeFileSync(path.join(outDir, 'log.txt'), `${log.join('\n')}\n`);
} catch (error) {
  note(`ERROR ${error.message}`);
  await page.screenshot({ path: path.join(outDir, 'error.png') }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
