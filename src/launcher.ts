#!/usr/bin/env node

import { configurePlaywrightBrowsersPath } from './launch-environment.js';

configurePlaywrightBrowsersPath(process.env, import.meta.url);
await import('./mcp-server.js');
