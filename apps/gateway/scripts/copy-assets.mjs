import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcLua = resolve(__dirname, '../src/lua');
const distLua = resolve(__dirname, '../dist/lua');

mkdirSync(distLua, { recursive: true });
cpSync(srcLua, distLua, { recursive: true });
