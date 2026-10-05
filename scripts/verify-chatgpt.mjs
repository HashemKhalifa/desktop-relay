import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run through the authenticated Computer Use tab, never through a second browser driver.
export async function createChatgptCheck(tab) {
  const initial = await tab.playwright.domSnapshot();
  assert(!initial.includes('heading "You said:"'), 'Use a fresh chat for this check');
  const composer = tab.playwright.getByRole('textbox', { name: 'Ask ChatGPT', exact: true });
  assert((await composer.innerText()).trim() === 'Desktop Relay', 'Select only Desktop Relay in the empty composer');
  const directory = await mkdtemp(join(tmpdir(), 'desktop-relay-chatgpt-'));
  const path = join(directory, 'fixture.txt');
  const marker = `RELAY_READ_OK_${randomUUID()}`;
  const lines = [marker, 'Second line for explicit preview.', 'Third line for reload verification.'];
  await writeFile(path, `${lines.join('\n')}\n`);
  const checks = [];
  let next = 'sendRead';

  function expectStep(step) {
    assert.equal(next, step, `Expected ${next} before ${step}`);
  }

  async function record(phase, image = undefined) {
    const screenshot = join(directory, `${phase}.jpg`);
    await writeFile(screenshot, image ?? await tab.screenshot({ fullPage: false }));
    checks.push({ phase, passed: true, screenshot });
    await writeFile(join(directory, 'report.json'), `${JSON.stringify({ fixture: path, checks }, null, 2)}\n`);
    return { phase, passed: true, screenshot };
  }

  async function assertRead(phase) {
    const snapshot = await tab.playwright.domSnapshot();
    assert(!snapshot.includes('button "Stop'), 'Wait for ChatGPT to finish; do not resend the prompt');
    const code = await tab.playwright.getByRole('code').allTextContents({ timeoutMs: 5000 });
    assert(code.some(text => text.trim() === marker), 'Expected the exact first line in the final answer');
    assert(snapshot.includes('button "Copy"'), 'Expected a completed assistant answer');
    assert(!snapshot.includes('iframe'), 'An ordinary read must not create a preview');
    assert(!snapshot.includes('button "Close viewer"'), 'An ordinary read must not open the viewer');
    return record(phase);
  }

  return {
    directory,
    async sendRead() {
      expectStep('sendRead');
      await composer.press('End');
      await tab.paste(null, `Read ${path} using read_file. Return only its exact first line in a code block.`);
      next = 'checkRead';
      await tab.playwright.getByRole('button', { name: 'Send', exact: true }).click();
      return tab.playwright.domSnapshot();
    },
    async checkRead() {
      expectStep('checkRead');
      const result = await assertRead('plain-read');
      next = 'reload';
      return result;
    },
    async reload() {
      expectStep('reload');
      await tab.reload();
      next = 'checkReload';
      return tab.playwright.domSnapshot();
    },
    async checkReload() {
      expectStep('checkReload');
      const result = await assertRead('after-reload');
      next = 'sendPreview';
      return result;
    },
    async sendPreview() {
      expectStep('sendPreview');
      await composer.fill(`Explicitly open an interactive file preview for ${path} using preview_relay_file.`);
      next = 'checkPreview';
      await tab.playwright.getByRole('button', { name: 'Send', exact: true }).click();
      return tab.playwright.domSnapshot();
    },
    async checkPreview() {
      expectStep('checkPreview');
      const snapshot = await tab.playwright.domSnapshot();
      assert(!snapshot.includes('button "Stop'), 'Wait for ChatGPT to finish; do not resend the prompt');
      const frame = tab.playwright.frameLocator('iframe').frameLocator('iframe');
      if (snapshot.includes('button "Open file ↗"')) {
        await frame.getByRole('button', { name: 'Open file ↗', exact: true }).click();
      } else {
        assert(snapshot.includes('button "Close preview"'), 'Expected an explicit preview card');
      }
      await frame.getByText(lines[2], { exact: true }).waitFor({ state: 'visible', timeoutMs: 10000 });
      const opened = await tab.playwright.domSnapshot();
      for (const line of lines) assert(opened.includes(line), `Missing fixture line: ${line}`);
      const image = await tab.screenshot({ fullPage: false });
      await tab.playwright.getByRole('button', { name: 'Close viewer', exact: true }).click();
      const closed = await tab.playwright.domSnapshot();
      assert(!closed.includes('button "Close viewer"'), 'Expected the viewer to close');
      const result = await record('explicit-preview', image);
      next = 'complete';
      return result;
    },
  };
}
