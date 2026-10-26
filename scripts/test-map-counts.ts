import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPage } from './lib/cdp';

/**
 * Focused rendered regression for #84. Serve a check branch with two listed factories running
 * on the same step, then: bun scripts/test-map-counts.ts <home-map-url> <output-directory>
 * Checks the actual text bounds as well as scroll sizes, so an overflowing ancestor cannot hide
 * a label even when the label itself reports no overflow. No database writes or fixture reset.
 */
const [url, out] = process.argv.slice(2);
if (!url || !out) throw new Error('usage: bun scripts/test-map-counts.ts <home-map-url> <out>');
mkdirSync(out, { recursive: true });
const page = await openPage(Bun.env);
try {
  await page.goto(url);
  await page.evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const check = () => {
      if (document.querySelector('[data-live="home-map"][data-state="ready"]')) resolve(true);
      else if (Date.now() >= deadline) reject(new Error('map did not become ready'));
      else setTimeout(check, 50);
    };
    check();
  })`);
  await page.evaluate('document.fonts.ready.then(() => true)');
  for (const width of [390, 1440, 1920]) {
    writeFileSync(join(out, `map-${width}.png`), await page.screenshot(width));
    const report = await page.evaluate<{
      sharedSteps: number;
      counts: { step: string; text: string; scrollWidth: number; clientWidth: number }[];
      failures: string[];
    }>(`(() => {
      const nodes = [...document.querySelectorAll('[data-step][data-live-count]')];
      const counts = [];
      const failures = [];
      for (const node of nodes) {
        const box = node.getBoundingClientRect();
        for (const row of node.querySelectorAll('[data-factory-count]')) {
          const range = document.createRange();
          range.selectNodeContents(row);
          const text = range.getBoundingClientRect();
          counts.push({ step: node.dataset.step, text: row.textContent,
            scrollWidth: row.scrollWidth, clientWidth: row.clientWidth });
          if (text.left < box.left || text.right > box.right ||
              text.top < box.top || text.bottom > box.bottom) {
            failures.push(node.dataset.step + ': text outside step: ' + row.textContent);
          }
          for (let ancestor = row; ancestor && ancestor !== node; ancestor = ancestor.parentElement) {
            if (ancestor.scrollWidth > ancestor.clientWidth ||
                ancestor.scrollHeight > ancestor.clientHeight) {
              failures.push(node.dataset.step + ': count container overflows: ' + row.textContent);
            }
          }
        }
      }
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i].getBoundingClientRect();
        for (const other of nodes.slice(i + 1)) {
          const b = other.getBoundingClientRect();
          if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
            failures.push('overlapping steps: ' + nodes[i].dataset.step + ', ' + other.dataset.step);
          }
        }
      }
      return { counts, failures, sharedSteps: nodes.filter(node =>
        node.querySelectorAll('[data-factory-count]').length >= 2).length };
    })()`);
    writeFileSync(join(out, `geometry-${width}.json`), `${JSON.stringify(report, null, 2)}\n`);
    assert.ok(report.sharedSteps > 0, 'fixture must have a step shared by at least two factories');
    assert.deepEqual(report.failures, [], `counts must be fully visible at ${width}px`);
    console.log(`PASS ${width}px: ${report.counts.length} labelled counts, no clipping or overlap`);
  }
} finally {
  await page.close();
}
