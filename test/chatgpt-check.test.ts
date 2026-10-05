import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { createChatgptCheck } from '../scripts/verify-chatgpt.mjs';

test('ChatGPT check refuses an existing conversation before touching its composer', async () => {
  const tab = { playwright: {
    domSnapshot: async () => '- heading "You said:" [level=4]',
    getByRole: () => { throw new Error('existing composer must not be touched'); },
  } };
  await assert.rejects(createChatgptCheck(tab), /fresh chat/);
});

test('ChatGPT check cannot resend after a send loses its acknowledgement', async () => {
  let sends = 0;
  const tab = {
    paste: async () => {},
    playwright: {
      domSnapshot: async () => '- textbox "Ask ChatGPT": Desktop Relay',
      getByRole: (role: string) => role === 'textbox' ? {
        innerText: async () => 'Desktop Relay',
        press: async () => {},
      } : {
        click: async () => { sends++; throw new Error('acknowledgement lost'); },
      },
    },
  };
  const check = await createChatgptCheck(tab);
  try {
    await assert.rejects(check.sendRead(), /acknowledgement lost/);
    await assert.rejects(check.sendRead(), /Expected checkRead/);
    assert.equal(sends, 1);
  } finally {
    await rm(check.directory, { recursive: true, force: true });
  }
});
