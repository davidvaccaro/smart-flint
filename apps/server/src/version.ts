import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './config.js';
export const serviceVersion: string = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version;
