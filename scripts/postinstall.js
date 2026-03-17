#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

const prefix = process.env.npm_config_prefix?.trim();
const packageJsonPath = process.env.npm_package_json?.trim();
const packageName = process.env.npm_package_name || 'clawpal-connect';

function log(message) {
  console.log(`[postinstall] ${message}`);
}

function main() {
  if (!prefix || !packageJsonPath) {
    log('skip: missing npm prefix or package path');
    return;
  }

  const packageDir = path.dirname(packageJsonPath);
  const sourceDist = path.join(packageDir, 'dist');
  if (!existsSync(sourceDist)) {
    log(`skip: dist not found at ${sourceDist}`);
    return;
  }

  const stableRoot = path.join(prefix, 'lib', `${packageName}-standalone`);
  const stableDist = path.join(stableRoot, 'dist');
  const binPath = path.join(prefix, 'bin', packageName);
  const cliTarget = path.join(stableDist, 'cli.js');

  mkdirSync(path.dirname(stableRoot), { recursive: true });
  mkdirSync(path.dirname(binPath), { recursive: true });

  rmSync(stableRoot, { recursive: true, force: true });
  mkdirSync(stableRoot, { recursive: true });
  cpSync(sourceDist, stableDist, { recursive: true });

  rmSync(binPath, { force: true });
  try {
    symlinkSync(cliTarget, binPath);
  } catch {
    writeFileSync(
      binPath,
      `#!/bin/sh\nexec node "${cliTarget}" "$@"\n`,
      'utf8',
    );
    chmodSync(binPath, 0o755);
  }

  log(`installed stable CLI at ${binPath}`);
}

main();
