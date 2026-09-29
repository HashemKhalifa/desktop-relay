import fs from 'node:fs';

export const relayIcon = `data:image/png;base64,${fs.readFileSync(new URL('../assets/icon.png', import.meta.url)).toString('base64')}`;
export const relayIcons = [{ src: relayIcon, mimeType: 'image/png', sizes: ['128x128'] }];
